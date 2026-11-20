/* ============================================================================
   config.js — LE SEUL FICHIER À PERSONNALISER pour chaque nouvelle boutique
   (le nom, le logo, la description, le WhatsApp… se règlent ensuite depuis
    l'espace propriétaire « vendeur.html », sans toucher au code).
   ============================================================================ */
window.NB_CONFIG = {

  /* ── 0) BACK-END : base de données NEON (via l'API Cloudflare du dossier « functions/ ») ───────────────────
     • backend : 'neon'      → aucune clé dans ce fichier : DATABASE_URL reste un SECRET côté Cloudflare.
     • apiUrl  : '/api'      → laissez tel quel (le site et l'API sont sur le même domaine Cloudflare Pages).           */
  backend: 'neon',
  apiUrl: '/api',

  /* ── 2) CACHE : durée pendant laquelle le navigateur du visiteur réutilise les
        données sans interroger l'API. Les modifications du propriétaire
        apparaissent donc chez les visiteurs après ce délai (5 à 10 minutes).    */
  cacheMinutes: 5,

  /* ── 3) APPARENCE ───────────────────────────────────────────────────────────  */
  couleur: '#2563eb',        // couleur principale de la boutique (bleu par défaut)
  devise: 'FCFA',            // texte affiché après les prix
  lotAffichage: 12,          // nombre de produits ajoutés à chaque défilement (chargement progressif)
  vitesseBande: 45,          // vitesse de la bande défilante en haut (pixels par seconde)

  /* ── 3 bis) WHATSAPP DU DÉVELOPPEUR (boutons « Notifiez-nous » / « Contactez-nous » de l'espace propriétaire)
        Format international sans + ni espaces, ex. '22961000000'. Laissez '' pour masquer la barre.      */
  whatsappSupport: '22961196907',

  /* ── 4) RÉGLAGES AVANCÉS ────────────────────────────────────────────────────  */
  cleCache: 'nb_cache_v1',   // nom de la mémoire du navigateur (changez-le pour forcer une mise à jour chez tous)
  cleePanier: 'nb_panier_v1'
};
