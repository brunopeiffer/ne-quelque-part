/* Mode classe : séance guidée sur un chapitre du programme d'économie de Terminale (STMG).
   Ce fichier lit l'état du jeu (STATE.life, yearBudget, countryById…) ; il ne modifie la partie que par
   - un tirage aléatoire reproductible (même « graine » pour toute la classe),
   - un carnet de notions alimenté à chaque décision.
   Appelé par app.js : CLASSE.onStart / onChoice / onEnd / render / renderEnd. */
(function () {
  const CL = window.CLASSE = { cfg: null };
  const LS = 'nq:classe', LS_STU = 'nq:classe:eleve';
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money$ = (v) => money(v);
  const pct = (v, d) => (v * 100).toFixed(d == null ? 0 : d).replace('.', ',') + ' %';
  const sgn = (v) => (v >= 0 ? '+ ' : '− ') + money$(Math.abs(v));

  // ---------- Chapitres ----------
  const CHAPS = {
    '1': { d: "Rôles de l'État : solde entre prélèvements et prestations, dépenses sociales, comparaison de cinq États.", pre: [{ n: 'État-providence ↔ État peu présent', p: ['FRA', 'NER'], w: 'Un État qui prélève et redistribue beaucoup face à un État qui le fait très peu.' }, { n: 'Trois modèles sociaux', p: ['FRA', 'USA', 'BRA'], w: 'Dépenses sociales fortes, moyennes et faibles.' }, { n: 'Cinq États', p: ['FRA', 'USA', 'BRA', 'IND', 'NER'], w: 'Le tableau complet de comparaison.' }], g: [{ a: 18, t: "Jusqu'à 18 ans : repérez ce que l'État fournit sans qu'on le voie (école, santé, sécurité)." }, { a: 40, t: "Arrêtez à 40 ans (pause) : calculez le solde avec l'État, c'est-à-dire ce qu'il reçoit moins ce qu'il verse." }, { a: 999, t: "Jusqu'à la fin de la vie : comparez avec l'autre pays dans le tableau « Comparer des États »." }], t: "Chapitre 1 · L'intervention de l'État", q: [
      "Quels rôles l'État joue-t-il dans la vie de votre personnage (régalien, redistributeur, producteur de services) ?",
      "Calculez le solde entre ce que votre personnage verse à l'État et ce qu'il en reçoit à 40 ans.",
      "Comparez avec le pays de votre voisin : État-providence ou État gendarme ? Justifiez avec trois chiffres." ] },
    '2': { d: "Externalités, asymétries d'information, biens publics, défaillances de l'État : un carnet de notions se remplit à chaque décision.", pre: [{ n: 'Riche · intermédiaire · pauvre', p: ['DEU', 'BRA', 'ETH'], w: 'Accès aux soins, reste à charge et sécurité très différents.' }, { n: 'France ↔ Niger', p: ['FRA', 'NER'], w: 'Un système de santé très protecteur face à un système où les ménages paient presque tout.' }, { n: 'États-Unis ↔ France', p: ['USA', 'FRA'], w: 'Deux organisations de la santé : marché et assurance publique.' }], g: [{ a: 25, t: "Vivez jusqu'à 25 ans : à chaque décision, regardez le carnet de notions qui se remplit." }, { a: 50, t: "Jusqu'à 50 ans : repérez une externalité (positive ou négative) et une asymétrie d'information." }, { a: 999, t: "Jusqu'à la fin : trouvez une défaillance de l'État et l'intervention qui pourrait la corriger." }], t: "Chapitre 2 · Défaillances du marché et de l'État", q: [
      "Relevez dans le carnet deux situations d'externalités (une positive, une négative) et expliquez-les.",
      "Relevez une asymétrie d'information (assurance, santé, crédit) : qui sait quoi ?",
      "Quelle intervention publique corrige la défaillance ? Observez-vous aussi une défaillance de l'État ?" ] },
    '3': { d: "Politique budgétaire vécue (prélèvements, prestations), inflation et pouvoir d'achat, crédit. Lien partiel avec le chapitre : le simulateur ne modélise pas la politique monétaire.", pre: [{ n: 'France ↔ Allemagne (zone euro)', p: ['FRA', 'DEU'], w: 'Deux pays soumis à la même monnaie et aux mêmes règles européennes.' }, { n: 'France ↔ États-Unis', p: ['FRA', 'USA'], w: 'Deux politiques économiques et sociales différentes.' }, { n: 'France ↔ Niger', p: ['FRA', 'NER'], w: 'Une grande marge de politique publique face à une marge très réduite.' }], g: [{ a: 25, t: "Jusqu'à 25 ans : repérez comment l'argent et les prix évoluent (inflation, crédit) dans la vie du personnage." }, { a: 40, t: "Arrêtez à 40 ans (pause) : faites le bilan budgétaire : ce que l'État prélève, ce qu'il verse, et le pouvoir d'achat qui reste." }, { a: 999, t: "Jusqu'à la fin : repérez l'effet d'un choc (inflation, catastrophe, dette) sur le pouvoir d'achat, puis comparez avec l'autre pays." }], t: "Chapitre 3 · Les politiques économiques de l'État et de l'Europe", q: [
      "Faites le bilan budgétaire de votre personnage à 40 ans : prélèvements, prestations, revenu disponible. Quel est l'effet de la politique budgétaire sur son pouvoir d'achat ?",
      "Relevez un épisode d'inflation ou de crédit dans sa vie : comment a-t-il réagi ? Quel instrument de politique économique pourrait agir sur ce problème ?",
      "Comparez avec l'autre pays : la marge de manœuvre de l'État est-elle la même ? Justifiez avec trois chiffres." ] },
    '8': { d: "Mondialisation vécue : migrations, transferts d'argent, accès au numérique. Lien limité : le simulateur ne modélise pas les échanges de biens.", pre: [{ n: "Pays d'émigration", p: ['MEX', 'IND', 'NER'], w: "Trois pays d'où l'on part vers des pays plus riches (États-Unis, Royaume-Uni, France)." }, { n: 'France ↔ Niger', p: ['FRA', 'NER'], w: "Un pays d'accueil et un pays de départ." }], g: [{ a: 25, t: "Jusqu'à 25 ans : repérez ce qui relie votre personnage au reste du monde (numérique, études, rencontres)." }, { a: 50, t: "Jusqu'à 50 ans : y a-t-il une décision de migration ou d'envoi d'argent ? Notez le choix et ses conséquences." }, { a: 999, t: "Jusqu'à la fin : comparez avec l'autre pays l'ouverture au monde (accès à Internet, migrations vécues)." }], t: "Chapitres 8 à 10 · Mondialisation et échanges (lien limité)", q: [
      "Relevez dans le récit une situation qui relie votre personnage à l'étranger (migration, transfert d'argent, emploi à l'étranger). Qui en profite, qui y perd ?",
      "Comparez l'accès à Internet et le niveau de vie des deux pays : que révèle l'insertion dans la mondialisation ?",
      "Le simulateur ne montre pas le commerce de biens : quelles données faudrait-il pour caractériser la balance commerciale ou le rôle des firmes multinationales ?" ] },
    '4': { d: 'Cotisations et impôts, progressivité, assurance et assistance, redistribution verticale et horizontale, risques sociaux couverts.', pre: [{ n: 'France ↔ Niger', p: ['FRA', 'NER'], w: 'Contraste maximal : prélèvements et protection sociale très différents.' }, { n: 'États-providence', p: ['FRA', 'SWE', 'DEU'], w: 'Comparer des systèmes proches mais distincts.' }, { n: 'France · États-Unis · Brésil', p: ['FRA', 'USA', 'BRA'], w: 'Trois modèles : protection forte, marchande, limitée.' }], g: [{ a: 18, t: "Jusqu'à 18 ans : notez le milieu familial (quartile) et comment les parents financent les besoins." }, { a: 25, t: "Entrée dans la vie active : lisez le détail cotisations, impôts et prestations dans la tuile." }, { a: 40, t: "Arrêtez à 40 ans (pause) : remplissez le tableau 1 de votre fiche et calculez le taux de prélèvement." }, { a: 60, t: "Jusqu'à la retraite : y a-t-il une pension ? Que couvre la protection sociale en cas de maladie ?" }, { a: 999, t: "Jusqu'à la fin de la vie, puis imprimez votre fiche de synthèse." }], t: "Chapitre 4 · Les politiques sociales", q: [
      "Calculez le taux de prélèvement obligatoire de votre personnage à 40 ans. Le système est-il progressif ?",
      "Distinguez cotisations sociales et impôts. Quelles prestations relèvent d'une logique d'assurance, lesquelles d'une logique d'assistance ?",
      "Donnez un exemple de redistribution verticale et un de redistribution horizontale observés dans la vie du personnage.",
      "Quels risques sociaux sont couverts dans son pays, lesquels ne le sont pas ? Quelles conséquences sur sa vie ?" ] },
    '5': { d: "Statut sur le marché du travail âge par âge, travail informel, absence de pension. Le tableau de classe donne un taux d'emploi approché.", pre: [{ n: 'Emploi formel ↔ informel', p: ['FRA', 'IND', 'NER'], w: 'Emploi protégé, emploi partiellement informel, emploi presque entièrement informel.' }, { n: 'France ↔ Niger', p: ['FRA', 'NER'], w: 'Protection de l\u2019emploi et pensions très inégales.' }], g: [{ a: 18, t: "Jusqu'à 18 ans : études ou travail précoce ? Repérez l'âge d'entrée dans la vie active." }, { a: 40, t: "Arrêtez à 40 ans (pause) : lisez la frise du statut et repérez les périodes sans emploi." }, { a: 999, t: "Jusqu'à la fin : retraite ou travail sans pension ? Copiez vos résultats pour le tableau de classe." }], t: "Chapitres 5 à 7 · Emploi et chômage", q: [
      "Retracez le statut de votre personnage sur le marché du travail (actif occupé, inactif…) âge par âge.",
      "Repérez des situations de sous-emploi, de travail informel ou d'absence de protection.",
      "Avec le tableau de classe, calculez un taux d'activité et un taux d'emploi sur l'ensemble des personnages." ] },
    '11': { d: 'Indice de développement estimé (santé, éducation, revenu) et chocs environnementaux vécus.', pre: [{ n: 'Développement élevé · moyen · faible', p: ['NOR', 'BRA', 'NER'], w: 'Santé, éducation et revenu très contrastés.' }, { n: 'France ↔ Niger', p: ['FRA', 'NER'], w: 'Deux niveaux de développement et d\u2019exposition aux chocs.' }], g: [{ a: 40, t: "Vivez jusqu'à 40 ans : notez les chocs environnementaux (sécheresse, inondation, eau)." }, { a: 999, t: "Jusqu'à la fin : comparez l'indice de développement de votre pays avec celui des autres." }], t: "Chapitre 11 · Croissance et développement durable", q: [
      "Comparez l'indice de développement estimé de votre pays avec celui de votre voisin : quels indicateurs expliquent l'écart ?",
      "Quels événements de la vie (sécheresse, inondation, eau, santé) montrent des limites d'une croissance non soutenable ?" ] },
    '12': { d: 'Seuils de pauvreté absolue et relative, part de la population pauvre, années vécues sous les seuils.', pre: [{ n: 'Pauvreté absolue et relative', p: ['FRA', 'BRA', 'NER'], w: 'France : surtout relative ; Niger : surtout absolue ; Brésil : fortes inégalités.' }, { n: 'Riche · intermédiaire · pauvre', p: ['DEU', 'BRA', 'ETH'], w: 'Trois niveaux de richesse pour voir reculer la pauvreté absolue.' }, { n: 'Inégalités fortes ↔ faibles', p: ['ZAF', 'SVK'], w: 'Un Gini très élevé face à un Gini très faible.' }], g: [{ a: 18, t: "Jusqu'à 18 ans : le niveau de vie dépend du ménage des parents. Notez le quartile du milieu familial." }, { a: 30, t: "Première vie active : le revenu disponible passe-t-il au-dessus des deux seuils ? À quel âge ?" }, { a: 40, t: "Arrêtez à 40 ans (pause) : notez les années passées sous le seuil absolu et sous le seuil relatif." }, { a: 65, t: "Repérez ce qui aggrave ou réduit la pauvreté : santé, études, enfants, dettes." }, { a: 999, t: "Jusqu'à la fin : retraite sans pension ? Comparez avec l'autre pays." }], t: "Chapitre 12 · La réduction de la pauvreté", q: [
      "Votre personnage est-il pauvre en termes absolus ? en termes relatifs ? À quels âges ?",
      "Pourquoi un même niveau de vie peut-il être « pauvre » dans un pays et pas dans un autre ?",
      "Quels facteurs (famille, études, santé, protection sociale) ont aggravé ou réduit sa pauvreté ?" ] },
  };
  const PRESETS = [
    { n: 'France ↔ Niger', p: ['FRA', 'NER'] }, { n: '5 pays du tableau', p: ['FRA', 'USA', 'BRA', 'IND', 'NER'] },
    { n: 'Riche · intermédiaire · pauvre', p: ['DEU', 'BRA', 'ETH'] }, { n: 'États-providence', p: ['FRA', 'SWE', 'DEU'] },
  ];

  // ---------- Carnet de notions : décision du jeu → notion du programme ----------
  const T = (ch, n, t) => ({ ch, n, t });
  const NOTIONS = {
    de_vaccination: T(2, 'Externalité positive · bien public', "Se vacciner protège aussi les autres : un bénéfice collectif que le marché rémunère mal. L'État finance ou rend obligatoire."),
    de_child_vaccines: T(2, 'Externalité positive · bien public', "La vaccination des enfants limite la circulation des maladies : un avantage pour tous, d'où l'intervention publique."),
    de_bednet: T(2, 'Externalité positive', "Une moustiquaire protège aussi les voisins : le bénéfice dépasse celui de l'acheteur."),
    de_malaria: T(2, 'Externalité · prévention', "Le paludisme se propage ; la prévention collective rapporte plus que la somme des choix individuels."),
    sm_cigarette: T(2, 'Externalité négative', "Le tabac coûte à la collectivité (soins, fumée passive) : une externalité négative, taxée pour la corriger."),
    de_quit_smoking: T(2, 'Externalité négative · coût social', "Arrêter de fumer réduit des coûts supportés par l'assurance maladie, donc par les autres."),
    de_alcohol: T(2, 'Externalité négative', "L'alcool provoque des accidents et des violences : des coûts imposés à d'autres."),
    de_drugs: T(2, 'Externalité négative', "La consommation de drogues pèse sur la santé publique et la sécurité."),
    de_addiction: T(2, 'Externalité négative · santé', "La dépendance coûte au malade, à ses proches et à la collectivité."),
    de_drunk_driving: T(2, 'Externalité négative', "Conduire ivre fait courir un risque à des tiers qui n'ont pas choisi."),
    de_fin_insurance: T(2, "Asymétrie d'information · assurance", "L'assureur connaît mal votre santé (sélection adverse) et vous pouvez moins vous protéger une fois assuré (aléa moral)."),
    de_health_warning: T(2, "Asymétrie d'information", "Le médecin sait plus que le patient : l'information est inégalement répartie."),
    de_screening: T(2, "Asymétrie d'information · prévention", "Le dépistage réduit l'ignorance du patient sur son propre état."),
    de_hypertension: T(2, "Asymétrie d'information · prévention", "Un risque silencieux : seule une consultation révèle l'information."),
    de_hiv_test: T(2, "Information · santé publique", "Se tester produit une information utile à soi et aux autres."),
    de_water: T(2, 'Bien commun', "L'accès à l'eau est un bien commun : difficile d'en exclure, facile de le surexploiter."),
    de_illness_followup: T(4, 'Protection sociale · risque maladie', "La part remboursée par la protection sociale et le reste à charge dépendent du pays : c'est le risque maladie."),
    de_illness_treat: T(4, 'Protection sociale · risque maladie', "Se soigner dépend du reste à charge et de l'accès aux soins."),
    de_flood: T(1, "Rôle de l'État · risques collectifs", "Face aux catastrophes, l'État protège, indemnise ou reconstruit (ou en est incapable)."),
    de_drought: T(11, 'Soutenabilité · climat', "La sécheresse rappelle les limites de ressources renouvelables sous contrainte climatique."),
    de_wildfire: T(11, 'Soutenabilité · climat', "Les incendies traduisent des tensions entre croissance, climat et ressources."),
    de_earthquake_repair: T(1, "Rôle de l'État · assurance des risques", "Reconstruire dépend des aides publiques et de l'assurance."),
    de_nepotism: T(2, "Défaillance de l'État", "Le favoritisme fausse l'attribution des emplois : une défaillance dans l'action publique."),
    de_bribe: T(2, "Défaillance de l'État · corruption", "Payer pour obtenir un service public : l'État ne remplit pas correctement sa mission."),
    de_extortion: T(1, "Fonction régalienne", "La sécurité est une mission de l'État (État gendarme) ; quand elle manque, d'autres la font payer."),
    de_neighbourhood_watch: T(1, "État gendarme · bien public", "La sécurité est un bien public : si l'État n'est pas assez présent, la communauté s'organise."),
    de_gun_home: T(1, "État gendarme", "Le monopole de la force est une fonction régalienne ; s'armer signale un manque de confiance."),
    de_robbery: T(1, "État gendarme", "Protéger les biens et les personnes est la mission historique de l'État."),
    de_gang: T(1, "État gendarme · inégalités", "Là où l'État ne protège pas ni n'intègre, d'autres organisations occupent l'espace."),
    de_protest: T(5, 'Négociations · conflits du travail', "Revendiquer collectivement pour modifier les conditions de travail ou les salaires."),
    de_strike: T(5, 'Négociations salariales', "La grève est un moyen de pression dans les négociations."),
    de_loan_shark: T(2, 'Exclusion bancaire · asymétrie', "Sans accès au crédit formel, l'emprunteur paie très cher : un marché défaillant."),
    de_microcredit: T(12, 'Réduction de la pauvreté · crédit', "Le microcrédit finance les plus pauvres exclus des banques."),
    de_tontine: T(2, 'Finance informelle', "Une épargne collective qui remplace des banques ou assurances absentes."),
    de_fin_savings: T(2, 'Épargne · finance informelle', "Choisir où placer son épargne dépend de l'accès à des institutions fiables."),
    de_retirement_savings: T(4, 'Retraite · capitalisation', "Épargner soi-même s'oppose à la répartition, où les actifs paient les pensions."),
    de_fin_pension: T(4, 'Retraite · assurance', "Cotiser pour une pension : logique d'assurance sociale."),
    de_retire_plan: T(4, 'Retraite · âge légal', "L'âge de la retraite et le montant de la pension dépendent des règles du pays."),
    de_no_pension: T(4, 'Risque vieillesse non couvert', "Sans pension, le risque vieillesse n'est pas couvert : on travaille ou l'on dépend de sa famille."),
    de_retire_early: T(4, 'Retraite · départ anticipé', "Partir plus tôt réduit la pension : arbitrage entre durée de cotisation et montant."),
    de_child_fees: T(12, 'Pauvreté · éducation', "Les frais de scolarité peuvent exclure les enfants des familles pauvres."),
    de_school_choice: T(4, 'Inégalités · égalité des chances', "Le choix d'école dépend des ressources : l'école publique corrige en partie les inégalités."),
    de_kid_school: T(4, "Inégalités · égalité des chances", "Public ou privé : l'accès à l'école reflète les inégalités socio-économiques."),
    de_literacy: T(12, 'Pauvreté · éducation', "Savoir lire ouvre l'accès à l'emploi et à la protection sociale."),
    fa_child_labor: T(12, 'Pauvreté absolue · travail des enfants', "Quand le revenu manque, les enfants travaillent au détriment de leur scolarité."),
    de_kid_work: T(12, 'Pauvreté absolue · travail des enfants', "L'arbitrage entre revenu immédiat et éducation future."),
    fa_child_marriage: T(12, 'Pauvreté · inégalités', "Le mariage précoce est lié à la pauvreté et réduit les perspectives des filles."),
    de_kid_care: T(4, 'Prestations familiales · garde', "L'aide à la garde des enfants relève de la politique familiale."),
    de_parents_care: T(4, 'Dépendance · solidarité', "Entre solidarité familiale et protection sociale : qui prend en charge la dépendance ?"),
    de_elder_home: T(4, 'Dépendance · protection sociale', "Le coût de la vieillesse dépendante est inégalement couvert."),
    de_parent_decline: T(4, 'Dépendance · protection sociale', "Qui finance l'aide aux personnes âgées : la famille ou la collectivité ?"),
    de_care_relative: T(4, 'Solidarité familiale', "À défaut de protection sociale, la famille assure le soin."),
    de_inheritance: T(4, 'Inégalités de patrimoine', "L'héritage reproduit ou accentue les inégalités entre ménages."),
    de_fin_will: T(4, 'Inégalités de patrimoine', "La transmission du patrimoine, partagée ou non, influence les inégalités."),
    de_first_job: T(5, 'Marché du travail · offre et demande', "Les emplois proposés dépendent du niveau d'études et du lieu : demande de travail."),
    de_job_change: T(5, 'Marché du travail', "Changer d'emploi dépend des offres disponibles et du risque pris."),
    de_retrain: T(5, "Politiques de l'emploi · formation", "Se reconvertir : la formation facilite le retour à l'emploi."),
    de_second_job: T(5, 'Sous-emploi', "Cumuler des emplois peut traduire un revenu insuffisant."),
    de_overtime: T(5, 'Durée du travail', "Heures supplémentaires : arbitrage temps de travail et revenu."),
    de_burnout: T(5, 'Conditions de travail', "L'intensité du travail pèse sur la santé."),
    de_startup: T(5, "Entrepreneuriat · emploi", "Créer son activité plutôt que chercher un emploi salarié."),
    de_fin_business: T(5, "Entrepreneuriat · risque", "Monter une affaire : revenus incertains, hors protection du salariat."),
    de_stall: T(5, 'Travail informel', "Une activité non déclarée offre un revenu, mais sans protection sociale."),
    de_gulf_job: T(12, 'Migrations de travail', "Partir pour un salaire plus élevé : une réponse individuelle à la pauvreté."),
    de_migration: T(12, 'Migrations · pauvreté', "Migrer pour fuir la pauvreté ou le manque d'emploi."),
    de_remittance: T(12, 'Transferts de migrants', "L'argent envoyé aux proches réduit la pauvreté dans le pays d'origine."),
    de_fin_remit: T(12, 'Transferts de migrants', "Les transferts financent soins, écoles, logements dans le pays d'origine."),
    de_fin_debt: T(12, 'Pauvreté · endettement', "Quand le revenu ne couvre pas les dépenses, l'endettement s'installe."),
    de_inflation: T(3, 'Inflation · pouvoir d’achat', "Quand les prix montent plus vite que les revenus, le pouvoir d'achat baisse ; la politique monétaire vise à stabiliser les prix."),
    de_inflation_hedge: T(3, 'Inflation · protection du patrimoine', "Se protéger de l'inflation : arbitrage entre épargne, placements et biens réels."),
    de_loan_request: T(3, 'Crédit · taux d’intérêt', "Le coût du crédit dépend des taux fixés par le marché et par la politique monétaire."),
    de_student_loan: T(3, 'Crédit · investissement en capital humain', "Emprunter pour étudier : un arbitrage entre dette présente et revenu futur."),
    de_war_flee: T(12, 'Pauvreté · conflits', "Les conflits détruisent revenus et patrimoine."),
  };

  // ---------- Outils de calcul ----------
  const erf = (x) => { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
  const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  const PhiInv = (p) => { let lo = -6, hi = 6; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
  const Z_ABS = 1095;                                      // 3 $ par jour en parité de pouvoir d'achat (seuil de pauvreté extrême, Banque mondiale)
  const median = (c) => 0.5 * (c.ppp || 12000);            // niveau de vie médian estimé
  const zRelOf = (c) => 0.6 * median(c);                   // seuil de pauvreté relative : 60 % du niveau de vie médian
  const sigma = (c) => Math.max(0.25, Math.SQRT2 * PhiInv(((c.gi != null ? c.gi : 0.38) + 1) / 2));
  const rateUnder = (c, z) => Phi(Math.log(z / median(c)) / sigma(c));   // part de la population sous le seuil (loi log-normale)
  const idh = (c) => { const hi = Math.max(0, Math.min(1, ((c.le || 70) - 20) / 65)), ei = Math.max(0, Math.min(1, (c.eys || 10) / 18)), ii = Math.max(0, Math.min(1, (Math.log(Math.max(100, c.ppp || 1000)) - Math.log(100)) / (Math.log(75000) - Math.log(100)))); return { h: hi, e: ei, i: ii, v: Math.cbrt(hi * ei * ii) }; };
  const probe = (L, q) => yearBudget(Object.assign({}, L, { age: Math.max(L.age, 35), stats: Object.assign({}, L.stats, { employment: 'employed', incomeQuartile: q, kids: [], married: false, relationship: 'single', education: 3 }), job: { mult: 1 }, herd: null, careCost: 0, insured: false, smoker: false, drinker: false, addicted: false, housing: null, hasCar: false, hasMoto: false, priority: null }));
  const countryNm = (c) => c.flag + ' ' + localize(c).name;
  const table = (rows) => '<table class="cl-t">' + rows.map((r) => '<tr' + (r[3] ? ' class="' + r[3] + '"' : '') + '><td>' + r[0] + '</td><td>' + r[1] + '</td>' + (r[2] != null ? '<td class="cl-n">' + r[2] + '</td>' : '') + '</tr>').join('') + '</table>';
  const chip = (txt, cls) => '<span class="cl-chip ' + (cls || '') + '">' + txt + '</span>';
  const note = (txt) => '<p class="cl-note">' + txt + '</p>';

  // ---------- Observation par chapitre ----------
  function viewCh4(L) {
    const b = L.budget || {}, c = L.countryData;
    if (L.age < 18) return note("Votre personnage est mineur : ses parents financent ses besoins. Avancez jusqu'à la vie active pour observer cotisations, impôts et prestations.");
    const gross = b.gross || 0, prel = b.taxes || 0, taux = gross > 0 ? prel / gross : 0;
    const recu = (b.aid || 0) + (b.healthCovered || 0) + (b.pensionAssist || 0);
    const rows = [
      ["Revenu d'activité", money$(b.income || 0)], ['Pension de retraite', money$(b.pension || 0)],
      ['= Revenu primaire', money$(gross), null, 'cl-sum'],
      ['− Cotisations sociales <small>(assurance)</small>', money$(b.cotis || 0)], ['− Impôts', money$(b.impots || 0)],
      ['+ Prestations sous conditions de ressources <small>(assistance · redistribution verticale)</small>', money$(b.aidAssist || 0)],
      ['+ Prestations familiales <small>(universelles · redistribution horizontale)</small>', money$(b.aidFamily || 0)],
      ['= Revenu disponible', money$(b.net || 0), null, 'cl-sum'],
    ];
    const q = [1, 2, 3, 4].map((k) => { const p = probe(L, k); return { k, rate: p.gross ? p.taxes / p.gross : 0 }; });
    const bars = q.map((x) => '<div class="cl-bar"><span>Quartile ' + x.k + '</span><i><u style="width:' + Math.min(100, x.rate * 200) + '%"></u></i><b>' + pct(x.rate) + '</b></div>').join('');
    const r = socialRate(c), oop = c.oop != null ? c.oop : 30;
    const risques = [
      ['Maladie', 'remboursé à ' + (100 - oop) + ' %', oop <= 30 ? 'ok' : oop <= 45 ? 'mid' : 'no'],
      ['Vieillesse', hasPension(L) ? 'pension contributive' : (r > 0.08 || c.ppp > 6000 ? 'minimum vieillesse seulement' : 'aucune'), hasPension(L) ? 'ok' : (r > 0.08 ? 'mid' : 'no')],
      ['Famille', r >= 0.05 ? 'prestations familiales' : 'très limitées', r >= 0.05 ? 'ok' : 'no'],
      ['Chômage', r >= 0.12 ? 'indemnisation' : 'peu ou pas', r >= 0.12 ? 'ok' : 'no'],
      ['Pauvreté', r >= 0.08 ? 'aides sous conditions' : 'très limitées', r >= 0.08 ? 'ok' : 'no'],
    ].map((x) => chip('<b>' + x[0] + '</b> · ' + x[1], x[2])).join('');
    return '<h5>Revenu primaire → revenu disponible (cette année)</h5>' + table(rows)
      + table([['Taux de prélèvement obligatoire (cotisations + impôts) ÷ revenu primaire', pct(taux, 1), null, 'cl-key'],
               ['Santé : dépense totale estimée', money$(b.healthTotal || 0)], ['— prise en charge par la protection sociale', money$(b.healthCovered || 0)], ['— reste à charge', money$(Math.max(0, b.health || 0))],
               ['Reçu de la collectivité (prestations + santé prise en charge) ÷ prélèvements', prel > 0 ? pct(recu / prel) : '—', null, 'cl-key']])
      + '<h5>Progressivité : taux de prélèvement selon le niveau de revenu (mêmes règles, ' + countryNm(c) + ')</h5><div class="cl-bars">' + bars + '</div>'
      + '<h5>Risques sociaux couverts (estimation du modèle)</h5><div class="cl-chips">' + risques + '</div>'
      + note("Quartile 1 : revenus les plus bas. Un taux qui monte avec le revenu signale un prélèvement progressif ; des prestations plus fortes pour les bas revenus signalent une redistribution verticale.");
  }
  function viewCh12(L) {
    const b = L.budget || {}, c = L.countryData, hist = L.hist || {};
    if (L.age < 18) return note('Avant 18 ans, le niveau de vie dépend du ménage des parents (quartile ' + (L.stats.incomeQuartile || 1) + ' sur 4). Avancez jusqu\'à la vie active.');
    const net = b.nv != null ? b.nv : (b.net || 0), za = Z_ABS, zr = zRelOf(c);
    let yAbs = 0, yRel = 0, yN = 0;
    Object.keys(hist).forEach((a) => { if (+a >= 18 && hist[a].b) { yN++; const v = hist[a].b.nv != null ? hist[a].b.nv : hist[a].b.net; if (v < za) yAbs++; if (v < zr) yRel++; } });
    const refs = [c, countryById('FRA'), countryById('NER')].filter((x, i, a) => x && a.findIndex((y) => y.id === x.id) === i);
    return '<h5>Où se situe votre personnage cette année ?</h5>' + table([
      ['Niveau de vie estimé (revenu disponible par unité de consommation du ménage)', money$(net)],
      ['Seuil de pauvreté <b>absolue</b> (3 $ par jour en parité de pouvoir d\'achat)', money$(za), net < za ? chip('Sous le seuil', 'no') : chip('Au-dessus', 'ok')],
      ['Seuil de pauvreté <b>relative</b> (60 % du niveau de vie médian du pays)', money$(zr), net < zr ? chip('Sous le seuil', 'no') : chip('Au-dessus', 'ok')],
      ['Années déjà vécues sous le seuil absolu / relatif', yAbs + ' / ' + yRel + ' sur ' + yN, null, 'cl-key']])
      + '<h5>Part de la population sous les seuils (estimation par pays)</h5>' + table(refs.map((x) => [countryNm(x), 'absolue ' + pct(rateUnder(x, za)), 'relative ' + pct(rateUnder(x, zRelOf(x)))]))
      + '<h5>Pourquoi les deux mesures diffèrent</h5>' + note("La pauvreté absolue compare à un besoin fixe (3 $ par jour) : elle recule quand un pays s'enrichit. La pauvreté relative compare au niveau de vie des autres habitants : elle mesure les inégalités. Le coefficient de Gini de " + localize(c).name + ' est de ' + String(c.gi).replace('.', ',') + '.');
  }
  function compare(L) {
    const ids = ['FRA', 'USA', 'BRA', 'IND', 'NER'];
    const rows = ids.map((id) => { const c = countryById(id); const p = probe(Object.assign({}, L, { countryData: c, country: id }), 2); return '<tr><td>' + countryNm(c) + '</td><td>' + pct(socialRate(c)) + '</td><td class="cl-n">' + pct(p.gross ? p.taxes / p.gross : 0) + ' · ' + money$(p.aid) + '</td></tr>'; }).join('');
    return '<h5>Comparer des États (même parcours, ailleurs)</h5><table class="cl-t"><tr><th></th><th>Dépenses sociales</th><th>Prélèvement · aides</th></tr>' + rows + '</table>';
  }
  function viewCh1(L) {
    const b = L.budget || {}, c = L.countryData;
    if (L.age < 18) return note("Votre personnage est mineur : observez le tableau des États ci-dessous et revenez à l'âge adulte.") + compare(L);
    const paye = b.taxes || 0, recu = (b.aid || 0) + (b.healthCovered || 0) + (b.pension || 0);
    return "<h5>Ce que l'État prend et ce qu'il rend (cette année)</h5>" + table([
      ['Prélèvements (cotisations + impôts)', money$(paye)], ['Prestations, pension et santé prise en charge', money$(recu)],
      ["Solde avec l'État", sgn(recu - paye), null, 'cl-key']])
      + "<h5>Les rôles de l'État dans ce pays</h5>" + table([
        ['Sécurité <small>(fonction régalienne)</small>', 'homicides : ' + c.hom + ' pour 100 000'],
        ['Santé', 'reste à charge des ménages : ' + c.oop + ' %'], ['Éducation', 'scolarité attendue : ' + c.eys + ' ans · enseignement supérieur : ' + c.ter + ' %'],
        ['Protection sociale <small>(État-providence)</small>', 'dépenses sociales ≈ ' + pct(socialRate(c)) + ' de la richesse nationale']])
      + compare(L);
  }
  function viewCh2(L) {
    const list = (L.carnet || []).filter((x) => x.ch === 2 || x.ch === 1);
    if (!list.length) return note("Le carnet est vide pour l'instant. À chaque décision liée au chapitre, la notion rencontrée s'inscrit ici : externalités, asymétries d'information, biens publics, défaillances de l'État.");
    return '<h5>Notions rencontrées</h5>' + list.slice(-8).reverse().map((x) => '<div class="cl-card"><b>' + esc(x.n) + '</b> <small>' + x.age + ' ans</small><br>' + esc(x.t) + '<br><em>Votre choix : ' + esc(x.label) + '</em></div>').join('');
  }
  function viewCh5(L) {
    const hist = L.hist || {}, col = { employed: '#2f9e8f', university: '#8a82e6', retired: '#f0a23a', none: '#c9c4b8' };
    const lab = { employed: 'Actif occupé', university: 'Études', retired: 'Retraité (inactif)', none: 'Sans emploi / inactif' };
    let strip = '';
    const cnt = { employed: 0, university: 0, retired: 0, none: 0 };
    for (let a = 0; a <= L.age; a++) {
      const e = (hist[a] && hist[a].emp) || 'none';
      if (a >= 16) cnt[e] = (cnt[e] || 0) + 1;
      strip += '<i title="' + a + ' ans" style="background:' + (a < 16 ? '#eadfc8' : col[e] || '#ccc') + '"></i>';
    }
    const informal = hasPension(L) ? 0 : cnt.employed;
    const legend = Object.keys(lab).map((k) => '<span class="cl-key-i"><u style="background:' + col[k] + '"></u>' + lab[k] + '</span>').join('');
    return '<h5>Statut sur le marché du travail, âge par âge</h5><div class="cl-strip">' + strip + '</div><div class="cl-legend">' + legend + '</div>'
      + table([['Années de vie active (actif occupé)', cnt.employed + ' ans'], ["Années d'études", cnt.university + ' ans'], ['Années sans emploi ou inactif (hors retraite)', cnt.none + ' ans'],
               ['Années en emploi sans droit à pension (informel ou non déclaré)', informal + ' ans', null, 'cl-key']])
      + note("Un taux d'activité, un taux d'emploi et un taux de chômage se calculent sur une population : utilisez le « tableau de classe » avec les résultats de tous les élèves.");
  }
  function viewCh11(L) {
    const c = L.countryData, refs = [c, countryById('FRA'), countryById('NER')].filter((x, i, a) => x && a.findIndex((y) => y.id === x.id) === i);
    const f = (v) => v.toFixed(2).replace('.', ',');
    const rows = refs.map((x) => { const d = idh(x); return '<tr><td>' + countryNm(x) + '</td><td>santé ' + f(d.h) + ' · éducation ' + f(d.e) + ' · revenu ' + f(d.i) + '</td><td class="cl-n"><b>' + f(d.v) + '</b></td></tr>'; }).join('');
    const ev = (L.log || []).filter((e) => /sécheresse|inondation|incendie|eau|tremblement|mousson|cyclone/i.test(e.text || '')).slice(-4).map((e) => '<li>' + e.age + ' ans : ' + esc(e.text) + '</li>').join('');
    return '<h5>Indice de développement humain estimé (santé, éducation, revenu)</h5><table class="cl-t"><tr><th></th><th>Composantes</th><th>Indice</th></tr>' + rows + '</table>'
      + note("Estimation simplifiée à partir de l'espérance de vie, de la scolarité attendue et du PIB par habitant : elle ne remplace pas l'IDH publié.")
      + '<h5>Chocs environnementaux vécus par votre personnage</h5>' + (ev ? '<ul class="cl-ul">' + ev + '</ul>' : note('Aucun pour le moment.'));
  }
  function viewCh3(L) {
    const b = L.budget || {}, c = L.countryData;
    const ev = (L.log || []).filter((e) => /inflation|prix|crédit|emprunt|dette|crise/i.test(e.text || '')).slice(-4).map((e) => '<li>' + e.age + ' ans : ' + esc(e.text) + '</li>').join('');
    const list = (L.carnet || []).filter((x) => x.ch === 3).slice(-4).map((x) => '<div class="cl-card"><b>' + esc(x.n) + '</b> <small>' + x.age + ' ans</small><br>' + esc(x.t) + '<br><em>Votre choix : ' + esc(x.label) + '</em></div>').join('');
    const bilan = L.age < 18 ? note("Avant 18 ans, le personnage ne perçoit pas de revenu : avancez jusqu'à la vie active pour voir l'effet de la politique budgétaire.")
      : '<h5>Bilan budgétaire de la personne (cette année)</h5>' + table([['Revenu primaire', money$(b.gross || 0)], ['− Prélèvements obligatoires', money$(b.taxes || 0)], ['+ Prestations (assistance, famille)', money$(b.aid || 0)], ['= Revenu disponible (pouvoir d\'achat)', money$(b.net || 0), null, 'cl-sum'], ['Solde de l\'État vis-à-vis du personnage', sgn((b.aid || 0) + (b.healthCovered || 0) + (b.pension || 0) - (b.taxes || 0)), null, 'cl-key']]);
    return bilan + '<h5>Inflation, crédit, chocs vécus</h5>' + (ev ? '<ul class="cl-ul">' + ev + '</ul>' : note('Aucun épisode pour le moment.')) + (list ? '<h5>Notions rencontrées</h5>' + list : '') + compare(L)
      + note("Ce chapitre est surtout observable par le budget et les épisodes d'inflation ou de crédit : le simulateur ne modélise pas la politique monétaire ni la dette publique.");
  }
  function viewCh8(L) {
    const c = L.countryData, hist = L.log || [];
    const ev = hist.filter((e) => /migr|étranger|passeur|expuls|frontière|transfert|envoy|rentr|visa|Golfe|contrat à l/i.test(e.text || '')).slice(-5).map((e) => '<li>' + e.age + ' ans : ' + esc(e.text) + '</li>').join('');
    const refs = [c, countryById('FRA'), countryById('NER')].filter((x, i, a) => x && a.findIndex((y) => y.id === x.id) === i);
    const rows = refs.map((x) => '<tr><td>' + countryNm(x) + '</td><td>' + (x.net != null ? x.net + ' %' : '—') + '</td><td class="cl-n">' + money$(x.ppp) + '</td></tr>').join('');
    return '<h5>Les liens de votre personnage avec le reste du monde</h5>' + (ev ? '<ul class="cl-ul">' + ev + '</ul>' : note('Aucune migration ni aucun transfert pour le moment.'))
      + '<h5>Ouverture au monde (comparaison)</h5><table class="cl-t"><tr><th></th><th>Usage d’Internet</th><th>PIB par habitant (PPA)</th></tr>' + rows + '</table>'
      + (L.birthOrigin ? note('Votre personnage a migré : observez les écarts de niveau de vie entre pays de départ et pays d’arrivée.') : '')
      + note("Le simulateur ne modélise pas les échanges de biens ni les firmes multinationales : cette tuile se limite aux migrations, aux transferts d'argent et à l'accès au numérique.");
  }
  const VIEWS = { '3': viewCh3, '8': viewCh8, '1': viewCh1, '2': viewCh2, '4': viewCh4, '5': viewCh5, '11': viewCh11, '12': viewCh12 };

  // ---------- Hooks appelés par app.js ----------
  CL.onChoice = (life, d) => {
    if (!CL.cfg) return;
    const n = NOTIONS[d.id];
    if (n) (life.carnet = life.carnet || []).push({ age: d.age, id: d.id, ch: n.ch, n: n.n, t: n.t, label: d.label });
  };
  CL.onStart = (life) => { if (CL.cfg) life.classe = { n: CL.cfg.n, ch: CL.cfg.c }; };
  CL.onEnd = () => { unseed(); };
  CL.render = () => {
    if (!CL.cfg || !STATE.life || !STATE.life.classe) return;
    const grid = $('#view-life .life-grid'); if (!grid) return;
    let el = $('#lifeClasse');
    if (!el) { el = document.createElement('div'); el.id = 'lifeClasse'; grid.insertBefore(el, grid.children[1] || null); }
    const ch = CHAPS[CL.cfg.c] || CHAPS['4'], fn = VIEWS[CL.cfg.c] || viewCh4;
    let body; try { body = fn(STATE.life); } catch (e) { body = note('Observation indisponible : ' + esc(e.message)); }
    const q = ch.q.map((x) => '<li>' + esc(x) + '</li>').join('');
    const L0 = STATE.life, gs = ch.g || [];
    let gi = gs.findIndex((x) => L0.age < x.a); if (gi < 0) gi = gs.length - 1;
    const guide = gs.length ? '<div class="cl-guide"><div class="cl-gsteps">' + gs.map((x, k) => '<i class="' + (k < gi ? 'done' : k === gi ? 'on' : '') + '">' + (k + 1) + '</i>').join('') + '</div><div><b>À faire maintenant · étape ' + (gi + 1) + ' sur ' + gs.length + '</b><br>' + esc(gs[gi].t) + '</div></div>' : '';
    el.innerHTML = '<h4>🎓 Observation · ' + esc(ch.t) + '</h4>' + guide + body + '<details class="cl-q"><summary>Consignes de la séance</summary><ol>' + q + '</ol></details>';
  };

  // ---------- Graine commune ----------
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function seed(key) { if (!CL._orig) CL._orig = Math.random; Math.random = mulberry(hash(String(CL.cfg.s) + (CL.cfg.m ? '' : key))); }
  function unseed() { if (CL._orig) { Math.random = CL._orig; CL._orig = null; } }

  // ---------- Code de séance ----------
  const enc = (cfg) => 'NQ' + btoa(unescape(encodeURIComponent(JSON.stringify(cfg)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const dec = (code) => { try { code = String(code || '').trim(); if (!code.startsWith('NQ')) return null; let b = code.slice(2).replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '='; const o = JSON.parse(decodeURIComponent(escape(atob(b)))); return o && o.p && o.p.length ? o : null; } catch (e) { return null; } };
  function activate(cfg) { CL.cfg = cfg; try { localStorage.setItem(LS, enc(cfg)); } catch (e) {} document.body.classList.add('classe-on'); buildTile(); }
  function leave() { unseed(); CL.cfg = null; try { localStorage.removeItem(LS); } catch (e) {} document.body.classList.remove('classe-on'); buildTile(); }
  CL.begin = (id) => { const c = countryById(id); if (!c) return; seed(id); showBirthCertModal(c); };
  CL.leave = leave;

  // ---------- Tuile d'accueil ----------
  function buildTile() {
    const hero = $('#view-intro .hero'); if (!hero) return;
    let el = $('#classeTile');
    if (!el) { el = document.createElement('div'); el.id = 'classeTile'; el.className = 'bt bt-class'; hero.appendChild(el); }
    if (CL.cfg) {
      const ch = CHAPS[CL.cfg.c] || CHAPS['4'];
      el.innerHTML = '<h3>🎓 Mode classe actif</h3><p><b>' + esc(CL.cfg.n || 'Séance') + '</b> · ' + esc(ch.t) + '</p>'
        + '<p class="cl-stu"><label>Votre prénom ou binôme <input id="clStudent" type="text" maxlength="40" value="' + esc(localStorage.getItem(LS_STU) || '') + '"></label></p>'
        + '<p class="cl-small">Vous êtes dans la séance. Cliquez sur <b>le pays que votre professeur vous a attribué</b> pour naître (si rien n’a été précisé, prenez le premier).</p><div class="cl-btns">' + CL.cfg.p.map((id) => { const c = countryById(id); return c ? '<button type="button" class="cl-go" data-id="' + id + '">' + countryNm(c) + '</button>' : ''; }).join('') + '</div>'
        + '<p class="cl-small">' + (CL.cfg.m ? 'Même hasard pour tous : à choix identiques, les vies sont comparables.' : 'Hasard différent selon le pays.') + '</p>'
        + '<div class="cl-btns"><button type="button" class="ghost" id="clAgg">Tableau de classe</button><button type="button" class="ghost" id="clLeave">Quitter le mode classe</button></div>';
      el.querySelectorAll('.cl-go').forEach((b) => b.addEventListener('click', () => { const v = ($('#clStudent') || {}).value || ''; try { localStorage.setItem(LS_STU, v); } catch (e) {} CL.begin(b.dataset.id); }));
      $('#clLeave', el).addEventListener('click', leave);
      $('#clAgg', el).addEventListener('click', aggregator);
      return;
    }
    el.innerHTML = '<h3>🎓 Vous êtes en classe ?</h3><p>Le mode classe donne à chaque élève un pays et un chapitre à observer, pour comparer des vies et en tirer des notions du cours.</p>'
      + '<div class="cl-btns cl-big"><button type="button" id="clStu">👩‍🎓 Je suis élève<small>J’ai un code de séance</small></button><button type="button" id="clTea">🧑‍🏫 Je suis enseignant<small>Créer une séance en 4 étapes</small></button></div>'
      + '<button type="button" class="ghost" id="clAgg0">Tableau de classe</button>';
    $('#clStu', el).addEventListener('click', joinModal);
    $('#clTea', el).addEventListener('click', wizard);
    $('#clAgg0', el).addEventListener('click', aggregator);
  }

  // ---------- Fenêtre « Rejoindre » (élève) ----------
  function overlay(id, html) {
    let m = $('#' + id); if (m) m.remove();
    m = document.createElement('div'); m.id = id; m.className = 'cl-ov';
    m.innerHTML = '<div class="cl-ovc"><button type="button" class="ca-x" aria-label="Fermer">×</button>' + html + '</div>';
    document.body.appendChild(m);
    $('.ca-x', m).addEventListener('click', () => m.remove());
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    return m;
  }
  function joinModal() {
    const m = overlay('clJoinOv', '<h3>Rejoindre la séance</h3><ol class="cl-steps"><li>Demandez le <b>code de séance</b> à votre professeur (il commence par NQ).</li><li>Collez-le ci-dessous, puis cliquez sur <b>Rejoindre</b>.</li><li>Choisissez ensuite le <b>pays qui vous est attribué</b> et cliquez sur « Naître ».</li></ol>'
      + '<label>Code de séance<input id="jCode" type="text" placeholder="NQ…" autocomplete="off"></label><p class="cl-err" id="jErr" hidden></p><button type="button" class="cl-main" id="jGo">Rejoindre la séance</button>');
    $('#jCode', m).focus();
    const go = () => { const cfg = dec($('#jCode', m).value), er = $('#jErr', m); if (!cfg) { er.textContent = 'Ce code n’est pas reconnu. Vérifiez qu’il est complet (il commence par NQ).'; er.hidden = false; return; } m.remove(); activate(cfg); };
    $('#jGo', m).addEventListener('click', go);
    $('#jCode', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  // ---------- Assistant enseignant en 4 étapes ----------
  function wizard() {
    const st = { step: 1, c: '4', pre: 0, custom: null, name: '', same: true };
    const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    const m = overlay('clWizard', '<div id="wzBody"></div>');
    const countriesOf = () => st.custom && st.custom.length ? st.custom : CHAPS[st.c].pre[st.pre].p;
    const dots = () => '<div class="wz-dots">' + ['Chapitre', 'Pays', 'Réglages', 'Code'].map((x, k) => '<span class="' + (k + 1 === st.step ? 'on' : k + 1 < st.step ? 'done' : '') + '"><b>' + (k + 1) + '</b>' + x + '</span>').join('') + '</div>';
    const nav = (back, next, nextLbl) => '<div class="wz-nav">' + (back ? '<button type="button" class="ghost" id="wzBack">← Retour</button>' : '<span></span>') + (next ? '<button type="button" class="cl-main" id="wzNext">' + nextLbl + '</button>' : '') + '</div>';
    const draw = () => {
      const body = $('#wzBody', m); let h = dots();
      if (st.step === 1) {
        h += '<h3>Que voulez-vous faire observer ?</h3><p class="cl-small">Choisissez le chapitre : le jeu affichera, pendant la vie, les indicateurs qui s’y rapportent.</p><div class="wz-cards">'
          + Object.keys(CHAPS).map((k) => '<button type="button" class="wz-card' + (st.c === k ? ' on' : '') + '" data-c="' + k + '"><b>' + esc(CHAPS[k].t) + '</b><span>' + esc(CHAPS[k].d) + '</span></button>').join('') + '</div>' + nav(false, true, 'Suivant →');
      } else if (st.step === 2) {
        h += '<h3>Quels pays attribuer ?</h3><p class="cl-small">Chaque élève ou binôme naîtra dans l’un de ces pays. Comparer deux pays très différents rend les notions visibles. Conseil pour ce chapitre : <b>' + esc(CHAPS[st.c].pre[0].n) + '</b>. ' + esc(CHAPS[st.c].pre[0].w) + '</p><div class="wz-cards">'
          + CHAPS[st.c].pre.map((p, k) => '<button type="button" class="wz-card' + (!st.custom && st.pre === k ? ' on' : '') + '" data-p="' + k + '"><b>' + esc(p.n) + (k === 0 ? ' <em>conseillé</em>' : '') + '</b><span>' + esc(p.w) + '<br><i>' + p.p.map((id) => { const c = countryById(id); return c ? countryNm(c) : id; }).join(' · ') + '</i></span></button>').join('') + '</div>'
          + '<details class="wz-more"' + (st.custom ? ' open' : '') + '><summary>Choisir d’autres pays</summary><label>Maintenez Ctrl (ou Cmd) pour en sélectionner plusieurs<select id="wzCtry" multiple size="7">' + (typeof COUNTRIES !== 'undefined' ? COUNTRIES.slice().sort((a, b) => localize(a).name.localeCompare(localize(b).name, 'fr')).map((c) => '<option value="' + c.id + '"' + (st.custom && st.custom.includes(c.id) ? ' selected' : '') + '>' + countryNm(c) + '</option>').join('') : '') + '</select></label></details>'
          + nav(true, true, 'Suivant →');
      } else if (st.step === 3) {
        h += '<h3>Derniers réglages</h3><label>Nom de la séance<input id="wzName" type="text" value="' + esc(st.name || (CHAPS[st.c].t.split(' · ')[0] + ' · ' + today)) + '"></label>'
          + '<label class="cl-chk wz-chk"><input type="checkbox" id="wzSame"' + (st.same ? ' checked' : '') + '><span><b>Même hasard pour tous les élèves</b> (recommandé)<br><small>À choix identiques, deux élèves d’un même pays obtiennent exactement la même vie, et les vies de pays différents restent comparables : vous pouvez dire « toutes choses égales par ailleurs ».</small></span></label>'
          + '<div class="wz-sum"><b>Récapitulatif</b><br>' + esc(CHAPS[st.c].t) + '<br>Pays : ' + countriesOf().map((id) => { const c = countryById(id); return c ? countryNm(c) : id; }).join(' · ') + '</div>' + nav(true, true, 'Générer le code →');
      } else {
        const cfg = { n: ($('#wzName', m) ? $('#wzName', m).value : st.name).trim() || 'Séance', c: st.c, p: countriesOf(), s: 1 + Math.floor(Math.random() * 99999), m: st.same ? 1 : 0 };
        st.cfg = st.cfg || cfg; const code = enc(st.cfg), url = location.origin + location.pathname + '?classe=' + code;
        const names = st.cfg.p.map((id) => { const c = countryById(id); return c ? localize(c).name : id; });
        const repart = names.map((n, k) => 'binômes ' + (k === 0 ? '1, ' + (names.length + 1) + ', …' : (k + 1) + ', ' + (names.length + k + 1) + ', …') + ' : ' + n).join(' · ');
        h += '<h3>✅ Votre séance est prête</h3><div class="wz-code"><label>Code de séance<input readonly id="wzCode" value="' + code + '"></label><button type="button" id="wzCopy">Copier le code</button></div>'
          + '<div class="wz-code"><label>Lien direct (les élèves arrivent déjà dans la séance)<input readonly id="wzUrl" value="' + url + '"></label><button type="button" id="wzCopyU">Copier le lien</button></div><p class="cl-small" id="wzMsg"></p>'
          + '<h4>Maintenant, avec la classe</h4><ol class="cl-steps"><li><b>Donnez le code ou le lien</b> aux élèves (projetez-le au tableau).</li><li>Ils ouvrent le site, cliquent sur <b>« Je suis élève »</b> et collent le code.</li><li><b>Répartissez les pays</b> : ' + esc(repart) + '.</li><li>Laissez-les vivre jusqu’à <b>40 ans</b> (5 à 15 minutes selon le rythme et les décisions), puis faites-les observer la tuile verte « Observation ».</li><li>En fin de vie, chaque élève clique sur <b>« Copier mes résultats »</b> ; collez toutes les lignes dans le <b>Tableau de classe</b>.</li></ol>'
          + '<div class="cl-btns"><button type="button" class="cl-main" id="wzTry">Essayer en tant qu’élève</button><button type="button" class="ghost" id="wzAgg">Ouvrir le tableau de classe</button><button type="button" class="ghost" id="wzNew">Créer une autre séance</button></div>';
      }
      body.innerHTML = h;
      body.querySelectorAll('.wz-card[data-c]').forEach((b) => b.addEventListener('click', () => { st.c = b.dataset.c; st.pre = 0; st.custom = null; draw(); }));
      body.querySelectorAll('.wz-card[data-p]').forEach((b) => b.addEventListener('click', () => { st.pre = +b.dataset.p; st.custom = null; draw(); }));
      const bk = $('#wzBack', body), nx = $('#wzNext', body);
      if (bk) bk.addEventListener('click', () => { st.step--; st.cfg = null; draw(); });
      if (nx) nx.addEventListener('click', () => {
        if (st.step === 2) { const sel = $('#wzCtry', body); if (sel && sel.selectedOptions.length) st.custom = [...sel.selectedOptions].map((o) => o.value); }
        if (st.step === 3) { st.name = $('#wzName', body).value; st.same = $('#wzSame', body).checked; }
        st.step++; draw();
      });
      if (st.step === 4) {
        const cp = (id, msg) => { const inp = $(id, body); inp.select(); (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject()).then(() => { $('#wzMsg', body).textContent = msg; }).catch(() => { $('#wzMsg', body).textContent = 'Sélectionnez le texte et copiez-le (Ctrl ou Cmd + C).'; }); };
        $('#wzCopy', body).addEventListener('click', () => cp('#wzCode', 'Code copié.'));
        $('#wzCopyU', body).addEventListener('click', () => cp('#wzUrl', 'Lien copié.'));
        $('#wzTry', body).addEventListener('click', () => { m.remove(); activate(st.cfg); });
        $('#wzAgg', body).addEventListener('click', () => { m.remove(); aggregator(); });
        $('#wzNew', body).addEventListener('click', () => { st.step = 1; st.cfg = null; draw(); });
      }
    };
    draw();
  }

  // ---------- Fiche de synthèse (écran de fin) ----------
  function results(L) {
    const hist = L.hist || {}, c = L.countryData, za = Z_ABS, zr = zRelOf(c);
    let sumInc = 0, sumPrel = 0, sumGross = 0, aid = 0, hc = 0, yAbs = 0, yRel = 0, act = 0, inac = 0, etu = 0;
    Object.keys(hist).forEach((k) => {
      const a = +k, h = hist[a]; if (!h.b) return;
      if (a >= 18) { const v = h.b.nv != null ? h.b.nv : h.b.net; if (v < za) yAbs++; if (v < zr) yRel++; if (h.emp === 'employed') act++; else if (h.emp === 'university') etu++; else if (h.emp !== 'retired') inac++; }
      sumInc += h.b.inc; sumGross += h.b.inc + h.b.pen; sumPrel += h.b.cot + h.b.imp; aid += h.b.aa + h.b.af; hc += h.b.hc;
    });
    return { act, inac, etu, yAbs, yRel, aid, hc, rate: sumGross > 0 ? sumPrel / sumGross : 0, avgInc: act ? sumInc / act : 0 };
  }
  const csvHead = 'classe;eleve;pays;sexe;milieu_quartile;age_deces;cause;patrimoine_final;revenu_moyen_actif;taux_prelevement;aides_cumulees;reste_charge_sante_cumule;annees_pauvrete_absolue;annees_pauvrete_relative;pension;annees_actif;annees_etudes;annees_inactif;notions';
  function csvLine(L) {
    const r = results(L), c = L.countryData;
    return [CL.cfg ? CL.cfg.n : '', localStorage.getItem(LS_STU) || '', c.id, L.sex, L.stats.incomeQuartile, L.deathAge || L.age, causeLabel(L.cause || ''), Math.round(L.stats.netAssets), Math.round(r.avgInc), (r.rate * 100).toFixed(1), Math.round(r.aid), Math.round(r.hc), r.yAbs, r.yRel, hasPension(L) ? 'oui' : 'non', r.act, r.etu, r.inac, (L.carnet || []).length].join(';');
  }
  CL.renderEnd = () => {
    const L = STATE.life; if (!CL.cfg || !L || !L.classe) return;
    const end = $('#view-end'); if (!end) return;
    let el = $('#classeSheet');
    if (!el) { el = document.createElement('div'); el.id = 'classeSheet'; end.insertBefore(el, end.firstChild); }
    const ch = CHAPS[CL.cfg.c] || CHAPS['4'];
    el.innerHTML = '<div class="bt bt-class"><h3>🎓 Mode classe · fiche de synthèse</h3><p>' + esc(ch.t) + ' · ' + esc(localize(L.countryData).name) + '</p><div class="cl-btns"><button type="button" id="clPrint">Imprimer ou enregistrer en PDF</button><button type="button" id="clCopy" class="ghost">Copier mes résultats (CSV)</button><button type="button" class="ghost" id="clAgg2">Tableau de classe</button></div><p class="cl-small" id="clMsg"></p></div>';
    $('#clPrint', el).addEventListener('click', () => printSheet(L));
    $('#clCopy', el).addEventListener('click', () => { const t = csvHead + '\n' + csvLine(L); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => { $('#clMsg', el).textContent = 'Résultats copiés : collez-les dans un tableur ou envoyez-les à votre enseignant.'; }).catch(() => { $('#clMsg', el).textContent = t; }); });
    $('#clAgg2', el).addEventListener('click', aggregator);
  };
  function printSheet(L) {
    const ch = CHAPS[CL.cfg.c] || CHAPS['4'], c = L.countryData, hist = L.hist || {}, r = results(L), d = idh(c);
    const ages = [20, 30, 40, 50, 60, 70, 80].filter((a) => hist[a] && hist[a].b);
    const head = "<tr><th>Âge</th><th>Revenu d'activité</th><th>Pension</th><th>Cotisations</th><th>Impôts</th><th>Assistance</th><th>Fam.</th><th>Santé (reste à charge)</th><th>Revenu disponible</th><th>Patrimoine</th></tr>";
    const rows = ages.map((a) => { const h = hist[a], b = h.b; return '<tr><td>' + a + '</td><td>' + money$(b.inc) + '</td><td>' + money$(b.pen) + '</td><td>' + money$(b.cot) + '</td><td>' + money$(b.imp) + '</td><td>' + money$(b.aa) + '</td><td>' + money$(b.af) + '</td><td>' + money$(b.hc) + '</td><td>' + money$(b.net) + '</td><td>' + money$(h.a) + '</td></tr>'; }).join('');
    const carnet = (L.carnet || []).map((x) => '<li><b>' + esc(x.n) + '</b> (' + x.age + ' ans, chap. ' + x.ch + ') — ' + esc(x.t) + ' <em>Choix : ' + esc(x.label) + '</em></li>').join('') || '<li>Aucune notion enregistrée.</li>';
    const qs = ch.q.map((x) => '<li>' + esc(x) + '<div class="cl-lines"></div></li>').join('');
    const f = L.sex === 'F' ? 'e' : '';
    let el = $('#classePrint'); if (el) el.remove();
    el = document.createElement('div'); el.id = 'classePrint';
    el.innerHTML = '<div class="cp-bar"><button type="button" onclick="window.print()">Imprimer</button><button type="button" onclick="document.getElementById(\'classePrint\').remove()">Fermer</button></div>'
      + '<h1>Né quelque part · Fiche de séance</h1><p><b>' + esc(CL.cfg.n) + '</b> · ' + esc(ch.t) + ' · élève : ' + esc(localStorage.getItem(LS_STU) || '………………') + '</p>'
      + '<h2>Le personnage</h2><p>' + esc(L.name.full || L.name.full_en || '') + ' · ' + (L.sex === 'F' ? 'femme' : 'homme') + ' · né' + f + ' en ' + esc(localize(c).name) + ' (' + (L.stats.birthPlaceType === 'rural' ? 'campagne' : 'ville') + ') · milieu familial : quartile ' + L.stats.incomeQuartile + ' sur 4 · décédé' + f + ' à ' + (L.deathAge || L.age) + ' ans (' + esc(causeLabel(L.cause || '')) + ') · patrimoine final ' + money$(L.stats.netAssets) + '.</p>'
      + '<h2>Ses ressources, âge par âge</h2><table class="cp-t">' + head + rows + '</table><p class="cl-small">Montants en euros, parité de pouvoir d\'achat. Estimations du modèle du jeu.</p>'
      + '<h2>Bilan</h2><ul><li>Taux de prélèvement moyen sur la vie : <b>' + pct(r.rate, 1) + '</b></li><li>Prestations d\'assistance et familiales reçues : <b>' + money$(r.aid) + '</b></li><li>Reste à charge de santé cumulé : <b>' + money$(r.hc) + '</b></li><li>Années sous le seuil de pauvreté absolue : <b>' + r.yAbs + '</b> · relative : <b>' + r.yRel + '</b></li><li>Années d\'activité : ' + r.act + ' · d\'études : ' + r.etu + ' · sans emploi ou inactif : ' + r.inac + '</li><li>Droit à une pension de retraite : <b>' + (hasPension(L) ? 'oui' : 'non') + '</b> · indice de développement estimé du pays : <b>' + d.v.toFixed(2).replace('.', ',') + '</b></li></ul>'
      + '<h2>Notions rencontrées</h2><ul>' + carnet + '</ul><h2>Questions</h2><ol>' + qs + '</ol>';
    document.body.appendChild(el);
  }

  // ---------- Tableau de classe (enseignant) ----------
  function aggregator() {
    let m = $('#classeAgg'); if (m) m.remove();
    m = document.createElement('div'); m.id = 'classeAgg';
    m.innerHTML = '<div class="ca-card"><button type="button" class="ca-x" aria-label="Fermer">×</button><h3>Tableau de classe</h3><p>Collez ici les lignes de résultats des élèves (une ligne par élève, bouton « Copier mes résultats »).</p><textarea id="caIn" rows="6" placeholder="classe;eleve;pays;…"></textarea><button type="button" id="caGo">Calculer</button><div id="caOut"></div></div>';
    document.body.appendChild(m);
    $('.ca-x', m).addEventListener('click', () => m.remove());
    $('#caGo', m).addEventListener('click', () => {
      const rows = $('#caIn', m).value.split(/\n+/).map((l) => l.trim()).filter((l) => l && !l.startsWith('classe;')).map((l) => l.split(';')).filter((a) => a.length >= 19);
      const out = $('#caOut', m); if (!rows.length) { out.textContent = 'Aucune ligne valide.'; return; }
      const by = {}; rows.forEach((r) => { (by[r[2]] = by[r[2]] || []).push(r); });
      const mean = (rs, i) => rs.reduce((s, r) => s + (parseFloat(String(r[i]).replace(',', '.')) || 0), 0) / rs.length;
      const lines = Object.keys(by).map((id) => {
        const rs = by[id], c = countryById(id), nm = c ? countryNm(c) : id, act = mean(rs, 15), etu = mean(rs, 16), ina = mean(rs, 17), tot = act + etu + ina || 1;
        return '<tr><td>' + nm + '</td><td>' + rs.length + '</td><td>' + Math.round(mean(rs, 5)) + '</td><td>' + mean(rs, 9).toFixed(1).replace('.', ',') + ' %</td><td>' + Math.round(mean(rs, 10)).toLocaleString('fr-FR') + '</td><td>' + mean(rs, 12).toFixed(1).replace('.', ',') + ' / ' + mean(rs, 13).toFixed(1).replace('.', ',') + '</td><td>' + Math.round(rs.filter((r) => r[14] === 'oui').length / rs.length * 100) + ' %</td><td>' + (act / tot * 100).toFixed(0) + ' %</td></tr>';
      }).join('');
      out.innerHTML = '<table class="cl-t"><tr><th>Pays</th><th>Élèves</th><th>Âge au décès</th><th>Prélèvement moyen</th><th>Aides cumulées</th><th>Années pauvres abs./rel.</th><th>Avec pension</th><th>Part des années en activité</th></tr>' + lines + '</table><p class="cl-small">Part des années en activité = années d\'activité ÷ (activité + études + inactivité) après 18 ans : une approche du taux d\'emploi. Montants en dollars PPA du modèle.</p>';
    });
  }

  // ---------- Démarrage ----------
  function init() {
    const q = new URLSearchParams(location.search).get('classe');
    let cfg = q ? dec(q) : null;
    if (!cfg) { try { cfg = dec(localStorage.getItem(LS)); } catch (e) {} }
    if (cfg) { CL.cfg = cfg; document.body.classList.add('classe-on'); }
    // Les données des pays arrivent après le chargement de la page : on attend qu'elles soient là.
    let tries = 0;
    const wait = setInterval(() => { if ((typeof COUNTRIES !== 'undefined' && COUNTRIES.length) || ++tries > 80) { clearInterval(wait); buildTile(); } }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0)); else setTimeout(init, 0);
})();
