-- ╔══════════════════════════════════════════════════════════════════════════════════╗
-- ║  NYA-BOUTIQUE × NEON  —  SCRIPT SQL UNIQUE (installation complète)                  ║
-- ║  Neon > SQL Editor > collez TOUT ce fichier > Run                                   ║
-- ╚══════════════════════════════════════════════════════════════════════════════════╝
--
--  Remplace les anciens scripts 1, 3 et 4 : tables, contrôles, déclencheurs, bannière promo, réseaux sociaux
--  ET les 2 nouveautés d'en-tête (boutique.description_courte, boutique.header_image_url).
--  REJOUABLE sans risque : aucune donnée n'est supprimée (« if not exists », « add column if not exists »).
--
--  SÉCURITÉ : sur Neon il n'y a plus de RLS ni de compte Google côté base. La base n'est joignable QUE par l'API
--  Cloudflare (functions/), qui garde DATABASE_URL secret, vérifie le Gmail du propriétaire et n'autorise que
--  les colonnes prévues. Les contrôles de données ci-dessous (prix, longueurs, https…) restent actifs dans la base.
--
--  ► ÉTAPE À PERSONNALISER : la ligne « v_email » (le Gmail du propriétaire).

-- 0) PROPRIÉTAIRE ─────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;   -- gen_random_uuid() (déjà natif sous Postgres 13+, sans effet si présent)

create table if not exists public.proprietaires (
  email   text primary key,
  cree_le timestamptz not null default now(),
  constraint proprietaires_email_valide check (email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);

do $$
declare
  v_email text := 'PROPRIETAIRE@gmail.com';     -- ◄◄◄ REMPLACEZ par le Gmail du vendeur (entre les apostrophes)
begin
  if lower(btrim(v_email)) like 'proprietaire@%' then
    raise notice 'ℹ️ Gmail du propriétaire NON renseigné : le reste du script s''exécute, mais personne ne pourra entrer dans l''espace propriétaire. Ajoutez-le ensuite avec SQL/2-gerer-proprietaire.sql.';
  else
    insert into public.proprietaires (email) values (lower(btrim(v_email))) on conflict do nothing;
    raise notice '✅ Propriétaire enregistré : %', lower(btrim(v_email));
  end if;
end $$;

-- Maximum 3 propriétaires (administrateurs) en même temps
create or replace function public.limiter_proprietaires() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.proprietaires) >= 3 then
    raise exception 'Maximum 3 propriétaires. Retirez-en un avant d''en ajouter un autre (voir SQL/2-gerer-proprietaire.sql).' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_limiter_proprietaires on public.proprietaires;
create trigger trg_limiter_proprietaires before insert on public.proprietaires
  for each row execute function public.limiter_proprietaires();

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) FONCTIONS UTILITAIRES (pures, utilisées par les contrôles)
-- ─────────────────────────────────────────────────────────────────────────────

-- Nombre de mots d'un texte (pour la limite de 60 mots de « Plus d'informations »)
create or replace function public.nb_mots(t text) returns integer
language sql immutable parallel safe as $$
  select case when btrim(coalesce(t, '')) = '' then 0
              else array_length(regexp_split_to_array(btrim(t), '\s+'), 1) end
$$;

-- Toutes les photos sont des adresses https de moins de 500 caractères
create or replace function public.images_valides(a text[]) returns boolean
language sql immutable parallel safe as $$
  select coalesce(bool_and(x ~* '^https://' and char_length(x) <= 500), false) from unnest(a) as x
$$;

-- Chaque ligne d'un tableau de textes est non vide et ≤ max caractères (caractéristiques)
create or replace function public.textes_valides(a text[], max_len integer) returns boolean
language sql immutable parallel safe as $$
  select coalesce(bool_and(char_length(btrim(x)) between 1 and max_len), true) from unnest(a) as x
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3) TABLE « boutique » : la fiche de la boutique (UNE seule ligne, id = 1)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.boutique (
  id            smallint primary key default 1 check (id = 1),
  nom           text    not null default 'Ma Boutique'  check (char_length(btrim(nom)) between 2 and 60),
  proprietaire  text    not null default ''             check (char_length(proprietaire) <= 80),
  description   text    not null default ''             check (char_length(description) <= 500),
  ville         text    not null default ''             check (char_length(ville) <= 60),
  localisation  text    not null default ''             check (char_length(localisation) <= 200),
  whatsapp      text    not null default ''             check (whatsapp = '' or whatsapp ~ '^[0-9]{8,15}$'),
  logo_url      text                                    check (logo_url is null or (logo_url ~* '^https://' and char_length(logo_url) <= 500)),
  -- ── Réglages DÉVELOPPEUR (le propriétaire ne peut PAS les modifier) ──
  melange_actif boolean not null default true,          -- true = produits mélangés à chaque chargement ; false = ordre fixe
  max_produits  integer not null default 16 check (max_produits between 1 and 5000),
  maj_le        timestamptz not null default now()
);
insert into public.boutique (id) values (1) on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) TABLE « produits »
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.produits (
  id              uuid primary key default gen_random_uuid(),
  nom             text    not null check (char_length(btrim(nom)) between 2 and 120),
  prix            integer not null check (prix between 1 and 100000000),
  ancien_prix     integer check (ancien_prix is null or (ancien_prix > prix and ancien_prix <= 100000000)),
  description     text    not null default '' check (char_length(description) <= 600),
  caracteristiques text[] not null default '{}' check (cardinality(caracteristiques) <= 15 and public.textes_valides(caracteristiques, 200)),
  plus_infos      text    not null default '' check (char_length(plus_infos) <= 700 and public.nb_mots(plus_infos) <= 60),
  images          text[]  not null check (cardinality(images) between 1 and 4 and public.images_valides(images)),
  visible         boolean not null default true,
  ordre           integer not null default 0 check (ordre between -100000 and 100000),
  cree_le         timestamptz not null default now(),
  maj_le          timestamptz not null default now()
);
create index if not exists produits_visible_ordre_idx on public.produits (visible, ordre, cree_le desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) TABLE « annonces » : la bande défilante en haut du site
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.annonces (
  id      uuid primary key default gen_random_uuid(),
  message text    not null check (char_length(btrim(message)) between 2 and 160),
  lien    text             check (lien is null or (lien ~* '^(https://|/|\?|#)' and char_length(lien) <= 500)),
  visible boolean not null default true,
  ordre   integer not null default 0 check (ordre between -100000 and 100000),
  cree_le timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) DÉCLENCHEURS : date de mise à jour, limites
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.maj_horodatage() returns trigger
language plpgsql as $$
begin new.maj_le := now(); return new; end $$;

drop trigger if exists trg_boutique_maj on public.boutique;
create trigger trg_boutique_maj before update on public.boutique
  for each row execute function public.maj_horodatage();

drop trigger if exists trg_produits_maj on public.produits;
create trigger trg_produits_maj before update on public.produits
  for each row execute function public.maj_horodatage();

-- Limite de produits (réglée par le développeur dans boutique.max_produits)
create or replace function public.limiter_produits() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_max integer; v_n integer;
begin
  select max_produits into v_max from public.boutique where id = 1;
  select count(*) into v_n from public.produits;
  if v_n >= coalesce(v_max, 16) then
    raise exception 'Limite de % produits atteinte pour cette boutique.', coalesce(v_max, 16) using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_limiter_produits on public.produits;
create trigger trg_limiter_produits before insert on public.produits
  for each row execute function public.limiter_produits();

-- Limite de 10 messages dans la bande défilante
create or replace function public.limiter_annonces() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.annonces) >= 10 then
    raise exception 'Limite de 10 messages atteinte pour la bande défilante.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_limiter_annonces on public.annonces;
create trigger trg_limiter_annonces before insert on public.annonces
  for each row execute function public.limiter_annonces();


-- Un lien est soit vide / NULL (l'icône est alors masquée sur le site), soit une adresse https:// sans espace.
alter table public.boutique
  add column if not exists tiktok_url   text
    check (tiktok_url   is null or tiktok_url   = '' or (tiktok_url   ~* '^https://[^[:space:]]+$' and char_length(tiktok_url)   <= 300)),
  add column if not exists facebook_url text
    check (facebook_url is null or facebook_url = '' or (facebook_url ~* '^https://[^[:space:]]+$' and char_length(facebook_url) <= 300)),
  add column if not exists promo_actif  boolean not null default false;   -- false = bannière masquée (rien ne change tant que le vendeur ne l'active pas)


-- ─────────────────────────────────────────────────────────────────────────────
-- 2) TABLE « promo_slides » : les 3 diapositives du carrousel (rang 1, 2 et 3, pas une de plus)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.promo_slides (
  rang      smallint    primary key check (rang between 1 and 3),     -- ordre d'affichage ; la clé primaire interdit tout doublon
  titre     text        not null default '' check (char_length(titre) <= 60),
  texte     text        not null default '' check (char_length(texte) <= 140),
  image_url text        check (image_url is null or (image_url ~* '^https://' and char_length(image_url) <= 500)),
  maj_le    timestamptz not null default now()
);

-- Les 3 lignes existent toujours : le vendeur ne fait que les modifier (jamais d'ajout ni de suppression)
insert into public.promo_slides (rang) values (1), (2), (3) on conflict (rang) do nothing;

-- Date de dernière modification automatique (fonction déjà créée par le script 1)
drop trigger if exists trg_promo_slides_maj on public.promo_slides;
create trigger trg_promo_slides_maj before update on public.promo_slides
  for each row execute function public.maj_horodatage();



-- ─────────────────────────────────────────────────────────────────────────────
-- 7) NOUVEAU : EN-TÊTE PERSONNALISABLE (image de fond + petite description sous le nom)
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.boutique
  add column if not exists description_courte text not null default '' check (char_length(description_courte) <= 90),
  add column if not exists header_image_url   text check (header_image_url is null or (header_image_url ~* '^https://' and char_length(header_image_url) <= 500));

-- ─────────────────────────────────────────────────────────────────────────────
-- 9) CONTENU DE DÉPART : un premier message pour la bande défilante (modifiable depuis l'espace propriétaire)
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.annonces (message, ordre)
select '🎉 Bienvenue dans notre boutique ! Paiement à la livraison', 0
where not exists (select 1 from public.annonces);


-- ─────────────────────────────────────────────────────────────────────────────
-- 8) VÉRIFICATIONS (facultatif : sélectionnez ces lignes seules, puis Run)
-- ─────────────────────────────────────────────────────────────────────────────
--   select email from public.proprietaires;                                                    -- votre Gmail
--   select nom, max_produits, description_courte, header_image_url from public.boutique;       -- 1 ligne
--   select rang from public.promo_slides order by rang;                                        -- 1, 2, 3
--
--  ► COMMANDES DÉVELOPPEUR (réservées à vous) :
--      update public.boutique set melange_actif = false;                 -- ordre fixe (champ « ordre »)
--      update public.boutique set max_produits = 30;                     -- limite de produits (16 par défaut)
--      update public.boutique set logo_url = 'https://img.mondomaine.com/logo/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.webp';  -- logo
--      update public.boutique set promo_actif = false;                   -- couper la bannière en urgence

-- ─────────────────────────────────────────────────────────────────────────────
-- 9) (RECOMMANDÉ) UTILISATEUR SQL À DROITS LIMITÉS POUR L'API
--    Par défaut Neon vous donne un rôle propriétaire (tous les droits). Pour qu'une faille éventuelle de l'API ne
--    puisse pas supprimer vos tables, créez un rôle restreint :
--      1) Neon Console > Branch > Roles > « New role » : nommez-le  nb_app  (copiez son mot de passe)
--      2) Lancez les lignes ci-dessous (retirez les « -- » devant chaque ligne), puis utilisez le
--         DATABASE_URL de CE rôle dans Cloudflare.
-- ─────────────────────────────────────────────────────────────────────────────
-- grant usage on schema public to nb_app;
-- grant select on public.proprietaires, public.boutique, public.produits, public.annonces, public.promo_slides to nb_app;
-- grant insert, update, delete on public.produits, public.annonces to nb_app;
-- grant insert, update on public.promo_slides to nb_app;
-- grant update (nom, proprietaire, description, description_courte, ville, localisation, whatsapp, header_image_url,
--               tiktok_url, facebook_url, promo_actif) on public.boutique to nb_app;
