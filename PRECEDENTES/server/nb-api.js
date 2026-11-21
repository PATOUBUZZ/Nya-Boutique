/* ============================================================================
   server/nb-api.js — API de Nya-Boutique (Cloudflare Pages Functions + base Neon)
   ----------------------------------------------------------------------------
   Remplace ce que faisaient Supabase (API REST, RLS, Auth Google, Storage) :
     GET  /api/rest/<table>?...      lecture PUBLIQUE (produits visibles, boutique, annonces visibles, promo)
     POST /api/db                    lecture/écriture PROPRIÉTAIRE uniquement (colonnes autorisées en liste blanche)
     GET  /api/auth/google           démarre la connexion Google
     GET  /api/auth/callback         retour de Google → cookie de session signé
     GET  /api/auth/session          qui suis-je ? (+ suis-je propriétaire ?)
     POST /api/auth/logout           déconnexion
     POST /api/storage/upload        envoi d'une image (propriétaire) → Cloudflare R2
     POST /api/storage/remove        suppression d'images (propriétaire)
   SÉCURITÉ
     • DATABASE_URL, GOOGLE_CLIENT_SECRET, SESSION_SECRET sont des SECRETS Cloudflare : jamais dans le navigateur.
     • Toutes les requêtes SQL sont paramétrées ; tables, colonnes et tris viennent de listes blanches.
     • Droits d'écriture = ceux de l'ancien RLS : seul un compte Google dont l'e-mail est dans « proprietaires ».
     • Cookie HttpOnly + Secure + SameSite=Lax ; protection CSRF (en-tête X-NB + contrôle de l'Origin).
     • Images : types et signature (octets magiques) vérifiés, 512 Ko max, noms de fichiers imposés.
   ============================================================================ */
import { neon } from '@neondatabase/serverless';

const SESSION_JOURS = 7;
const MAX_IMAGE = 524288;                                   // 512 Ko, comme l'ancien bucket
const CHEMIN_IMAGE = /^[a-z0-9_-]{1,40}\/[0-9a-f-]{36}\.(webp|jpg|jpeg|png)$/i;
const TYPES_IMAGE = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

/* ── Tables : colonnes lisibles / écrivables (équivalent des « grant » + RLS de l'ancien SQL) ── */
const PRODUIT_ECRIT = ['nom', 'prix', 'ancien_prix', 'description', 'caracteristiques', 'plus_infos', 'images', 'visible', 'ordre'];
const TABLES = {
  boutique: {
    lire: ['id', 'nom', 'proprietaire', 'description', 'description_courte', 'ville', 'localisation', 'whatsapp', 'logo_url', 'header_image_url',
      'melange_actif', 'max_produits', 'tiktok_url', 'facebook_url', 'promo_actif', 'maj_le'],
    public: ['nom', 'proprietaire', 'description', 'description_courte', 'ville', 'localisation', 'whatsapp', 'logo_url', 'header_image_url',
      'melange_actif', 'tiktok_url', 'facebook_url', 'promo_actif'],
    // logo_url, melange_actif, max_produits : réservés au développeur (SQL), comme avant
    ecrire: ['nom', 'proprietaire', 'description', 'description_courte', 'ville', 'localisation', 'whatsapp', 'header_image_url', 'tiktok_url', 'facebook_url', 'promo_actif'],
    ops: ['update'], filtres: ['id'], tris: ['id']
  },
  produits: {
    lire: ['id', ...PRODUIT_ECRIT, 'cree_le', 'maj_le'],
    public: ['id', 'nom', 'prix', 'ancien_prix', 'description', 'caracteristiques', 'plus_infos', 'images', 'ordre', 'cree_le'],
    publicFiltre: 'visible = true',
    ecrire: PRODUIT_ECRIT, ops: ['insert', 'update', 'delete'], filtres: ['id'], tris: ['ordre', 'cree_le', 'nom', 'prix']
  },
  annonces: {
    lire: ['id', 'message', 'lien', 'visible', 'ordre', 'cree_le'],
    public: ['id', 'message', 'lien', 'ordre', 'cree_le'],
    publicFiltre: 'visible = true',
    ecrire: ['message', 'lien', 'visible', 'ordre'], ops: ['insert', 'update', 'delete'], filtres: ['id'], tris: ['ordre', 'cree_le']
  },
  promo_slides: {
    lire: ['rang', 'titre', 'texte', 'image_url', 'maj_le'],
    public: ['rang', 'titre', 'texte', 'image_url'],
    ecrire: ['rang', 'titre', 'texte', 'image_url'], ops: ['insert', 'update', 'upsert'], filtres: ['rang'], tris: ['rang'], conflit: 'rang'
  }
};

/* ── Utilitaires ── */
const enc = new TextEncoder();
const q = (id) => '"' + id + '"';                       // les identifiants viennent TOUJOURS des listes blanches
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extra } });
}
const echec = (message, status = 400, code = '') => json({ error: { message, code } }, status, { 'Cache-Control': 'no-store' });
function b64u(buf) { let s = ''; new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b))); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function deB64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); }
function egal(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function cookies(req) { const o = {}; (req.headers.get('Cookie') || '').split(/;\s*/).forEach((c) => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i)] = c.slice(i + 1); }); return o; }
function cookie(nom, valeur, url, maxAge) {
  return `${nom}=${valeur}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (url.protocol === 'https:' ? '; Secure' : '');
}
function manque(env, noms) { const m = noms.filter((n) => !env[n]); return m.length ? `Configuration serveur incomplète : ${m.join(', ')} (voir GUIDE-NEON-CLOUDFLARE.md).` : ''; }

async function cle(env) { return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function signer(env, charge) {
  const corps = b64u(enc.encode(JSON.stringify(charge)));
  const sig = await crypto.subtle.sign('HMAC', await cle(env), enc.encode(corps));
  return corps + '.' + b64u(sig);
}
async function lireSession(req, env) {
  if (!env.SESSION_SECRET) return null;
  const jeton = cookies(req).nb_session; if (!jeton) return null;
  const [corps, sig] = jeton.split('.'); if (!corps || !sig) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await cle(env), deB64u(sig), enc.encode(corps)))) return null;
    const c = JSON.parse(new TextDecoder().decode(deB64u(corps)));
    return c && c.exp > Date.now() / 1000 && typeof c.email === 'string' ? c : null;
  } catch (e) { return null; }
}
const base = (env) => neon(env.DATABASE_URL);
async function estProprietaire(env, session) {
  if (!session) return false;
  const r = await base(env).query('select 1 from public.proprietaires where email = $1 limit 1', [String(session.email).toLowerCase()]);
  return r.length > 0;
}
/** Écritures : requête du même site uniquement (CSRF) */
function memeSite(req, url) {
  if (req.headers.get('X-NB') !== '1') return false;
  const o = req.headers.get('Origin');
  return !o || o === url.origin;
}
async function exigerProprietaire(req, url, env) {
  if (!memeSite(req, url)) return { err: echec('Requête refusée (origine).', 403, '42501') };
  const s = await lireSession(req, env);
  if (!s) return { err: echec('permission denied : connectez-vous.', 401, '42501') };
  if (!(await estProprietaire(env, s))) return { err: echec('permission denied : compte non propriétaire.', 403, '42501') };
  return { session: s };
}

/* ── Lecture publique, syntaxe compatible avec l'ancienne API (select, order, limit, id=eq.1) ── */
function construireLecture(nomTable, params, publique) {
  const T = TABLES[nomTable]; if (!T) throw new Error('Table inconnue');
  const lisibles = publique ? T.public : T.lire;
  let cols = '*';
  const where = [], val = []; let ordre = '', limite = '';
  for (const [k, v] of params) {
    if (k === 'select') {
      const l = v.split(',').map((x) => x.trim()).filter(Boolean);
      if (!l.length || l.some((c) => !lisibles.includes(c))) throw new Error('Colonne non autorisée');
      cols = l.map(q).join(', ');
    } else if (k === 'order') {
      ordre = ' order by ' + v.split(',').map((p) => {
        const [c, d = 'asc'] = p.split('.');
        if (!T.tris.includes(c) || !['asc', 'desc'].includes(d)) throw new Error('Tri non autorisé');
        return q(c) + ' ' + d;
      }).join(', ');
    } else if (k === 'limit') {
      const n = parseInt(v, 10); if (!(n > 0 && n <= 1000)) throw new Error('Limite invalide'); limite = ' limit ' + n;
    } else if (T.filtres.includes(k) || k === 'visible') {
      const m = /^eq\.(.{1,60})$/.exec(v); if (!m) throw new Error('Filtre non autorisé');
      if (k === 'visible') continue;                       // en public, « visible = true » est de toute façon imposé
      val.push(m[1]); where.push(q(k) + ' = $' + val.length);
    } else throw new Error('Paramètre non autorisé : ' + k);
  }
  if (cols === '*') cols = lisibles.map(q).join(', ');
  if (publique && T.publicFiltre) where.push(T.publicFiltre);
  return { text: `select ${cols} from public.${q(nomTable)}` + (where.length ? ' where ' + where.join(' and ') : '') + ordre + limite, val };
}

async function lecturePublique(req, ctx, nomTable) {
  const url = new URL(req.url), env = ctx.env;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cleCache = new Request(url.toString(), { method: 'GET' });
  if (cache) { const hit = await cache.match(cleCache); if (hit) return hit; }
  let requete;
  try { requete = construireLecture(nomTable, url.searchParams, true); } catch (e) { return echec(e.message, 400); }
  try {
    const rows = await base(env).query(requete.text, requete.val);
    const rep = json(rows, 200, { 'Cache-Control': 'public, max-age=30' });
    if (cache && ctx.waitUntil) ctx.waitUntil(cache.put(cleCache, rep.clone()));   // limite les réveils de la base Neon
    return rep;
  } catch (e) { return echec('Lecture impossible.', 502, e.code || ''); }
}

/* ── POST /api/db : propriétaire ── */
function valeurOk(v) { return v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === 'string')); }
function nettoyer(T, o, op) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Données invalides');
  const ks = Object.keys(o); if (!ks.length) throw new Error('Aucune donnée');
  ks.forEach((k) => { if (!T.ecrire.includes(k) || !valeurOk(o[k])) throw new Error('Colonne non autorisée : ' + k); });
  return ks;
}
async function ecritureProprietaire(req, ctx, url) {
  const env = ctx.env;
  const auth = await exigerProprietaire(req, url, env); if (auth.err) return auth.err;
  let b; try { b = await req.json(); } catch (e) { return echec('Requête invalide.'); }
  const T = TABLES[b && b.table]; if (!T) return echec('Table inconnue.');
  const op = b.op || 'select';
  if (op !== 'select' && !T.ops.includes(op)) return echec('permission denied : opération interdite.', 403, '42501');
  const eq = Array.isArray(b.eq) ? b.eq : [];
  const val = [], where = [];
  try {
    eq.forEach((f) => {
      if (!Array.isArray(f) || !T.filtres.includes(f[0]) || !valeurOk(f[1]) || Array.isArray(f[1])) throw new Error('Filtre non autorisé');
      val.push(f[1]); where.push(q(f[0]) + ' = $' + val.length);
    });
    const W = where.length ? ' where ' + where.join(' and ') : '';
    let text;
    if (op === 'select') {
      const r = construireLecture(b.table, new URLSearchParams([
        ['select', Array.isArray(b.columns) ? b.columns.join(',') : (b.columns && b.columns !== '*' ? String(b.columns).replace(/\s+/g, '') : T.lire.join(','))],
        ...(b.order && b.order.length ? [['order', b.order.map((o) => o[0] + '.' + (o[1] ? 'asc' : 'desc')).join(',')]] : []),
        ...(b.limit ? [['limit', String(b.limit)]] : []),
        ...eq.map((f) => [f[0], 'eq.' + f[1]])
      ]), false);
      return json({ data: await base(env).query(r.text, r.val) }, 200, { 'Cache-Control': 'no-store' });
    }
    if (op === 'insert' || op === 'upsert') {
      const lignes = Array.isArray(b.values) ? b.values : [b.values];
      if (!lignes.length || lignes.length > 20) throw new Error('Données invalides');
      const ks = nettoyer(T, lignes[0], op); const p = [];
      const groupes = lignes.map((l) => { nettoyer(T, l, op); return '(' + ks.map((k) => { p.push(l[k] === undefined ? null : l[k]); return '$' + p.length; }).join(', ') + ')'; });
      text = `insert into public.${q(b.table)} (${ks.map(q).join(', ')}) values ${groupes.join(', ')}`;
      if (op === 'upsert') {
        if (b.onConflict !== T.conflit) throw new Error('Conflit non autorisé');
        text += ` on conflict (${q(T.conflit)}) do update set ` + ks.filter((k) => k !== T.conflit).map((k) => `${q(k)} = excluded.${q(k)}`).join(', ');
      }
      return json({ data: await base(env).query(text + ' returning *', p) }, 200, { 'Cache-Control': 'no-store' });
    }
    if (!where.length) throw new Error('Filtre obligatoire');
    if (op === 'update') {
      const ks = nettoyer(T, b.values, op), p = [...val];
      const sets = ks.map((k) => { p.push(b.values[k]); return q(k) + ' = $' + p.length; });
      return json({ data: await base(env).query(`update public.${q(b.table)} set ${sets.join(', ')}${W} returning *`, p) }, 200, { 'Cache-Control': 'no-store' });
    }
    if (op === 'delete') return json({ data: await base(env).query(`delete from public.${q(b.table)}${W} returning *`, val) }, 200, { 'Cache-Control': 'no-store' });
    return echec('Opération inconnue.');
  } catch (e) {
    // Messages de la base (limites, contraintes) transmis tels quels : l'interface vendeur les traduit
    return echec(String(e.message || 'Erreur'), e.code ? 400 : 400, e.code || '');
  }
}

/* ── Connexion Google (OAuth 2.0, flux « code », secret gardé côté serveur) ── */
async function googleDebut(req, url, env) {
  const m = manque(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET']); if (m) return new Response(m, { status: 500 });
  const etat = b64u(crypto.getRandomValues(new Uint8Array(18)));
  const p = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/api/auth/callback', response_type: 'code', scope: 'openid email', state: etat, prompt: 'select_account' });
  return new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + p, 'Set-Cookie': cookie('nb_oauth', etat, url, 600), 'Cache-Control': 'no-store' } });
}
async function googleRetour(req, url, env) {
  const aller = (msg) => new Response(null, { status: 302, headers: { Location: '/vendeur.html' + (msg ? '?erreur=' + msg : ''), 'Cache-Control': 'no-store' } });
  const m = manque(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET']); if (m) return new Response(m, { status: 500 });
  const code = url.searchParams.get('code'), etat = url.searchParams.get('state'), attendu = cookies(req).nb_oauth;
  if (!code || !etat || !attendu || !egal(etat, attendu)) return aller('connexion');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/api/auth/callback', grant_type: 'authorization_code' })
  });
  if (!r.ok) return aller('connexion');
  let c;
  try { c = JSON.parse(new TextDecoder().decode(deB64u(String((await r.json()).id_token).split('.')[1]))); } catch (e) { return aller('connexion'); }
  // jeton reçu directement de Google (TLS) : on contrôle tout de même émetteur, destinataire, expiration et e-mail vérifié
  const okEmetteur = c.iss === 'https://accounts.google.com' || c.iss === 'accounts.google.com';
  if (!okEmetteur || c.aud !== env.GOOGLE_CLIENT_ID || !(c.exp > Date.now() / 1000) || c.email_verified !== true || !c.email) return aller('connexion');
  const jeton = await signer(env, { email: String(c.email).toLowerCase(), exp: Math.floor(Date.now() / 1000) + SESSION_JOURS * 86400 });
  const h = new Headers({ Location: '/vendeur.html', 'Cache-Control': 'no-store' });
  h.append('Set-Cookie', cookie('nb_session', jeton, url, SESSION_JOURS * 86400));
  h.append('Set-Cookie', cookie('nb_oauth', '', url, 0));
  return new Response(null, { status: 302, headers: h });
}

/* ── Images (Cloudflare R2) ── */
function signatureImage(o, type) {
  const b = new Uint8Array(o.slice(0, 12));
  if (type === 'image/png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/webp') return String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP';
  return false;
}
async function envoyerImage(req, url, env) {
  const auth = await exigerProprietaire(req, url, env); if (auth.err) return auth.err;
  if (!env.IMAGES) return echec('Stockage R2 non configuré (binding IMAGES).', 500);
  const chemin = url.searchParams.get('path') || '';
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!CHEMIN_IMAGE.test(chemin)) return echec('Nom de fichier refusé.');
  if (!TYPES_IMAGE[type]) return echec('Type d’image refusé (WebP, JPEG ou PNG).');
  const corps = await req.arrayBuffer();
  if (corps.byteLength > MAX_IMAGE) return echec('Payload too large : photo trop lourde (512 Ko max).', 413);
  if (!corps.byteLength || !signatureImage(corps, type)) return echec('Fichier image invalide.');
  if (await env.IMAGES.head(chemin)) return echec('Fichier déjà existant.', 409);
  await env.IMAGES.put(chemin, corps, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  const publique = (env.IMAGES_PUBLIC_URL || url.origin + '/img').replace(/\/+$/, '');
  return json({ path: chemin, url: publique + '/' + chemin }, 200, { 'Cache-Control': 'no-store' });
}
async function supprimerImages(req, url, env) {
  const auth = await exigerProprietaire(req, url, env); if (auth.err) return auth.err;
  let b; try { b = await req.json(); } catch (e) { return echec('Requête invalide.'); }
  const l = Array.isArray(b && b.paths) ? b.paths.filter((p) => typeof p === 'string' && CHEMIN_IMAGE.test(p)).slice(0, 20) : [];
  if (l.length && env.IMAGES) await env.IMAGES.delete(l);
  return json({ deleted: l.length }, 200, { 'Cache-Control': 'no-store' });
}

/* ── Routeur ── */
export async function handleApi(ctx) {
  const { request: req, env } = ctx; const url = new URL(req.url);
  const chemin = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  try {
    const m = manque(env, ['DATABASE_URL']);
    if (req.method === 'GET' && chemin.startsWith('/rest/')) return m ? echec(m, 500) : lecturePublique(req, ctx, chemin.slice(6));
    if (req.method === 'GET' && chemin === '/auth/google') return googleDebut(req, url, env);
    if (req.method === 'GET' && chemin === '/auth/callback') return googleRetour(req, url, env);
    if (req.method === 'GET' && chemin === '/auth/session') {
      const s = await lireSession(req, env);
      const owner = s && !m ? await estProprietaire(env, s) : false;
      return json({ session: s ? { user: { email: s.email } } : null, owner }, 200, { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'POST' && chemin === '/auth/logout') {
      if (!memeSite(req, url)) return echec('Requête refusée (origine).', 403);
      return json({ ok: true }, 200, { 'Set-Cookie': cookie('nb_session', '', url, 0), 'Cache-Control': 'no-store' });
    }
    if (m) return echec(m, 500);
    if (req.method === 'POST' && chemin === '/db') return ecritureProprietaire(req, ctx, url);
    if (req.method === 'POST' && chemin === '/storage/upload') return envoyerImage(req, url, env);
    if (req.method === 'POST' && chemin === '/storage/remove') return supprimerImages(req, url, env);
    return echec('Introuvable.', 404);
  } catch (e) { return echec('Erreur serveur.', 500); }
}

/* ── Service des images : GET /img/<dossier>/<uuid>.<ext> ── */
export async function handleImage(ctx) {
  const { request: req, env } = ctx;
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Méthode non autorisée', { status: 405 });
  const chemin = decodeURIComponent(new URL(req.url).pathname.replace(/^\/img\//, ''));
  if (!env.IMAGES || !CHEMIN_IMAGE.test(chemin)) return new Response('Introuvable', { status: 404 });
  const o = await env.IMAGES.get(chemin); if (!o) return new Response('Introuvable', { status: 404 });
  return new Response(req.method === 'HEAD' ? null : o.body, { headers: {
    'Content-Type': (o.httpMetadata && o.httpMetadata.contentType) || 'image/webp',
    'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ETag: o.httpEtag
  } });
}
