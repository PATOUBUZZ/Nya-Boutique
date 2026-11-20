-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  NYA-BOUTIQUE — GÉRER LES PROPRIÉTAIRES (ADMINS) 👥  (3 maximum)             ║
-- ║  Formulaire à réutiliser : modifiez UNIQUEMENT le bloc « ÉTAPE 1 », puis Run ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝
--
--  CE QUE FAIT CE SCRIPT (en un seul passage)
--    • RETIRE jusqu'à 3 propriétaires  (v_retirer)
--    • AJOUTE jusqu'à 3 propriétaires  (v_ajouter)  — les 3 en même temps si vous voulez
--    • Garantit : 3 propriétaires maximum au total, et jamais 0 (personne ne serait plus
--      capable d'entrer dans l'espace vendeur).
--
--  SÉCURITÉS
--    • PAR DÉFAUT LE SCRIPT NE CHANGE RIEN : il affiche un APERÇU (qui sera retiré / ajouté /
--      la liste finale). Pour appliquer : écrivez  v_confirmer := 'APPLIQUER'  puis relancez.
--    • Tout est vérifié avant d'écrire : si une adresse est invalide ou si le total dépasse 3,
--      RIEN n'est modifié et un message en français vous explique pourquoi.
--    • Retirer un propriétaire ne supprime PAS ses produits : il perd seulement l'accès.
--
--  EXEMPLES
--    Ajouter 3 personnes :   v_ajouter := array['a@gmail.com','b@gmail.com','c@gmail.com'];
--    Remplacer 1 par 1 :     v_retirer := array['ancien@gmail.com'];  v_ajouter := array['nouveau@gmail.com'];
--    Retirer seulement :     v_retirer := array['ancien@gmail.com'];  v_ajouter := array[]::text[];

do $proprietaires$
declare
  -- ═══════════════════ ÉTAPE 1 — VOS CHOIX (à modifier) ═══════════════════

  v_ajouter  text[] := array['', '', ''];
  -- Adresses Google à AJOUTER (jusqu'à 3). Laissez '' pour « personne ».
  -- Exemple : array['proprio1@gmail.com', 'proprio2@gmail.com', 'proprio3@gmail.com']

  v_retirer  text[] := array['', '', ''];
  -- Adresses à RETIRER (jusqu'à 3). Laissez '' pour « personne ».

  v_confirmer text := '';
  -- ''          = APERÇU seulement, rien n'est modifié.
  -- 'APPLIQUER' = applique les changements.

  -- ═══════════════════ FIN DE L'ÉTAPE 1 — ne touchez plus à rien en dessous ═══════════════════

  v_add  text[] := '{}';
  v_del  text[] := '{}';
  v_x    text;
  v_actuel   text[];
  v_final    text[];
  v_a_retirer text[];
  v_deja     text[];
  v_inconnus text[];
begin
  -- 1) Nettoyage : minuscules, sans espaces, sans doublons, sans cases vides
  foreach v_x in array coalesce(v_ajouter, '{}') loop
    v_x := lower(btrim(coalesce(v_x, '')));
    if v_x <> '' and not (v_x = any (v_add)) then v_add := v_add || v_x; end if;
  end loop;
  foreach v_x in array coalesce(v_retirer, '{}') loop
    v_x := lower(btrim(coalesce(v_x, '')));
    if v_x <> '' and not (v_x = any (v_del)) then v_del := v_del || v_x; end if;
  end loop;

  -- 2) Contrôles de forme
  if coalesce(array_length(v_add, 1), 0) > 3 then raise exception 'v_ajouter : 3 adresses maximum à la fois.'; end if;
  if coalesce(array_length(v_del, 1), 0) > 3 then raise exception 'v_retirer : 3 adresses maximum à la fois.'; end if;
  foreach v_x in array v_add loop
    if v_x !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'Adresse « % » invalide (v_ajouter). Exemple correct : prenom@gmail.com', v_x;
    end if;
  end loop;
  foreach v_x in array v_del loop
    if v_x = any (v_add) then
      raise exception '« % » est à la fois dans v_ajouter et v_retirer : choisissez l''un des deux.', v_x;
    end if;
  end loop;
  if coalesce(array_length(v_add, 1), 0) = 0 and coalesce(array_length(v_del, 1), 0) = 0 then
    raise exception 'Rien à faire : renseignez v_ajouter et/ou v_retirer dans l''ÉTAPE 1.';
  end if;

  -- 3) Calcul du résultat
  select coalesce(array_agg(email order by cree_le), '{}') into v_actuel from public.proprietaires;
  v_a_retirer := array(select unnest(v_del) intersect select unnest(v_actuel));
  v_inconnus  := array(select unnest(v_del) except  select unnest(v_actuel));
  v_deja      := array(select unnest(v_add) intersect select unnest(v_actuel));
  v_add       := array(select unnest(v_add) except   select unnest(v_actuel));   -- ceux déjà présents sont ignorés
  v_final     := array(select unnest(array(select unnest(v_actuel) except select unnest(v_a_retirer))) union select unnest(v_add));

  if coalesce(array_length(v_final, 1), 0) > 3 then
    raise exception 'REFUSÉ : le résultat ferait % propriétaires (3 maximum). Retirez d''abord quelqu''un (v_retirer). Actuellement : %',
      array_length(v_final, 1), array_to_string(v_actuel, ', ');
  end if;
  if coalesce(array_length(v_final, 1), 0) = 0 then
    raise exception 'REFUSÉ : il ne resterait AUCUN propriétaire, personne ne pourrait plus entrer dans l''espace vendeur. Ajoutez quelqu''un dans le même passage.';
  end if;

  raise notice E'\n──────── APERÇU ────────\n  Actuellement      : %\n  Seront retirés    : %\n  Seront ajoutés    : %\n  Déjà présents (ignorés) : %\n  Introuvables à retirer (ignorés) : %\n  RÉSULTAT FINAL    : % (% sur 3)\n────────────────────────',
    coalesce(nullif(array_to_string(v_actuel, ', '), ''), '(aucun)'),
    coalesce(nullif(array_to_string(v_a_retirer, ', '), ''), '(personne)'),
    coalesce(nullif(array_to_string(v_add, ', '), ''), '(personne)'),
    coalesce(nullif(array_to_string(v_deja, ', '), ''), '-'),
    coalesce(nullif(array_to_string(v_inconnus, ', '), ''), '-'),
    array_to_string(v_final, ', '), array_length(v_final, 1);

  if v_confirmer <> 'APPLIQUER' then
    raise notice E'👀 APERÇU SEULEMENT : rien n''a été modifié.\nPour appliquer, écrivez  v_confirmer := ''APPLIQUER''  puis relancez.';
    return;
  end if;

  -- 4) Application : on retire d'abord, puis on ajoute (la limite de 3 est aussi imposée par la base)
  if coalesce(array_length(v_a_retirer, 1), 0) > 0 then
    delete from public.proprietaires where email = any (v_a_retirer);
  end if;
  if coalesce(array_length(v_add, 1), 0) > 0 then
    insert into public.proprietaires (email) select unnest(v_add);
  end if;

  raise notice '✅ FAIT. Propriétaires actuels : %', (select string_agg(email, ', ' order by cree_le) from public.proprietaires);
end
$proprietaires$;

-- ─────────────────────────────────────────────────────────────────────────────
-- VOIR LA LISTE (sélectionnez ces lignes seules, puis Run)
--   select email, cree_le from public.proprietaires order by cree_le;
-- ─────────────────────────────────────────────────────────────────────────────
-- Note : l'adresse doit être celle du compte Google avec lequel la personne se connecte.
