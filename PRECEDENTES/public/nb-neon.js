/* ============================================================================
   nb-neon.js — client du back-end NEON pour l'espace vendeur (chargé avant vendeur.js)
   ----------------------------------------------------------------------------
   Offre la même interface que l'ancien client (from().select().eq()…, rpc, auth, storage) mais parle à l'API
   Cloudflare « /api » (voir server/nb-api.js). vendeur.js et vendeur-promo.js n'ont donc presque rien à changer.
   La session est un cookie HttpOnly posé par le serveur : aucun jeton n'est lisible par le JavaScript de la page.
   ============================================================================ */
(function () {
  'use strict';
  var cfg = window.NB_CONFIG || {};
  var API = String(cfg.apiUrl || '/api').replace(/\/+$/, '');
  var ecouteurs = [], urls = {};

  function appel(chemin, opts) {
    opts = opts || {};
    var h = { 'X-NB': '1' }; if (opts.type) h['Content-Type'] = opts.type;
    return fetch(API + chemin, { method: opts.method || 'GET', headers: h, body: opts.corps, credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.text().then(function (t) { var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { } return { ok: r.ok, status: r.status, json: j }; }); });
  }
  function erreurDe(rep) {
    var e = (rep.json && rep.json.error) || {};
    return { message: e.message || ('Erreur ' + rep.status), code: e.code || String(rep.status) };
  }

  /* ───── Constructeur de requêtes (sous-ensemble utile) ───── */
  function Requete(table) { this.q = { table: table, op: 'select', columns: '*', eq: [], order: [], limit: null }; this.mode = null; }
  Requete.prototype.select = function (cols) { if (this.q.op === 'select') this.q.columns = cols || '*'; return this; };
  Requete.prototype.insert = function (v) { this.q.op = 'insert'; this.q.values = v; return this; };
  Requete.prototype.update = function (v) { this.q.op = 'update'; this.q.values = v; return this; };
  Requete.prototype.upsert = function (v, o) { this.q.op = 'upsert'; this.q.values = v; this.q.onConflict = o && o.onConflict; return this; };
  Requete.prototype.delete = function () { this.q.op = 'delete'; return this; };
  Requete.prototype.eq = function (c, v) { this.q.eq.push([c, v]); return this; };
  Requete.prototype.order = function (c, o) { this.q.order.push([c, !(o && o.ascending === false)]); return this; };
  Requete.prototype.limit = function (n) { this.q.limit = n; return this; };
  Requete.prototype.single = function () { this.mode = 'single'; return this; };
  Requete.prototype.maybeSingle = function () { this.mode = 'maybe'; return this; };
  Requete.prototype.then = function (ok, ko) {
    var self = this;
    return appel('/db', { method: 'POST', type: 'application/json', corps: JSON.stringify(this.q) }).then(function (rep) {
      if (!rep.ok) return { data: null, error: erreurDe(rep) };
      var rows = (rep.json && rep.json.data) || [];
      if (self.mode === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
      if (self.mode === 'maybe') return rows.length <= 1 ? { data: rows[0] || null, error: null } : { data: null, error: { message: 'Plusieurs lignes retournées', code: 'PGRST116' } };
      return { data: rows, error: null };
    }, function (e) { return { data: null, error: { message: (e && e.message) || 'Failed to fetch' } }; }).then(ok, ko);
  };

  function session() {
    return appel('/auth/session').then(function (r) { return r.json || { session: null, owner: false }; }).catch(function () { return { session: null, owner: false }; });
  }

  function creer() {
    return {
      from: function (t) { return new Requete(t); },
      rpc: function (nom) {
        if (nom !== 'est_proprietaire') return Promise.resolve({ data: null, error: { message: 'Fonction inconnue' } });
        return session().then(function (s) { return { data: s.owner === true, error: null }; });
      },
      auth: {
        getSession: function () { return session().then(function (s) { return { data: { session: s.session }, error: null }; }); },
        signInWithOAuth: function () { window.location.href = API + '/auth/google'; return Promise.resolve({ data: {}, error: null }); },
        signOut: function () {
          return appel('/auth/logout', { method: 'POST' }).then(function () { ecouteurs.forEach(function (f) { try { f('SIGNED_OUT', null); } catch (e) { } }); return { error: null }; });
        },
        onAuthStateChange: function (f) { ecouteurs.push(f); return { data: { subscription: { unsubscribe: function () { ecouteurs = ecouteurs.filter(function (x) { return x !== f; }); } } } }; }
      },
      storage: {
        from: function () {
          return {
            upload: function (chemin, blob, opts) {
              return appel('/storage/upload?path=' + encodeURIComponent(chemin), { method: 'POST', type: (opts && opts.contentType) || blob.type, corps: blob }).then(function (rep) {
                if (!rep.ok) return { data: null, error: erreurDe(rep) };
                urls[chemin] = rep.json.url; return { data: { path: chemin }, error: null };
              }).catch(function (e) { return { data: null, error: { message: (e && e.message) || 'Failed to fetch' } }; });
            },
            getPublicUrl: function (chemin) { return { data: { publicUrl: urls[chemin] || (location.origin + '/img/' + chemin) } }; },
            remove: function (chemins) { return appel('/storage/remove', { method: 'POST', type: 'application/json', corps: JSON.stringify({ paths: chemins }) }).then(function () { return { error: null }; }); }
          };
        }
      }
    };
  }
  window.NBNeon = { createClient: creer };
})();
