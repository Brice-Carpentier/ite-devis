(() => {
  "use strict";

  const STORAGE_KEY = "ite_clients_v1";

  // ---------- Firebase (compte + synchronisation multi-appareils) ----------

  const firebaseConfig = {
    apiKey: "AIzaSyDQzQ1Vc1PFmAfK6n8O5X7AijD-p6SZ8Rg",
    authDomain: "metrages-pour-vt-ite---iti.firebaseapp.com",
    projectId: "metrages-pour-vt-ite---iti",
    storageBucket: "metrages-pour-vt-ite---iti.firebasestorage.app",
    messagingSenderId: "308598591326",
    appId: "1:308598591326:web:205a68fa20127b44bf89cf",
  };
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
    console.warn("Persistance hors-ligne Firestore indisponible :", err.code);
  });

  /* ---------------------------------------------------------
     Formules métier ITE (confirmées par l'utilisateur) :
     - Surface nette façade = largeur*hauteur - somme(surfaces ouvertures)
     - Tableaux (fenêtre ET porte) = (2*hauteur + largeur) * quantité
     - Appuis (fenêtre uniquement, pas les portes) = largeur * quantité
  --------------------------------------------------------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Photos (façades et côtes ITI) ----------
  // Les photos sont redimensionnées côté client avant stockage pour rester raisonnable
  // en taille (le stockage local du navigateur a une capacité limitée).

  function resizeImageFile(file, maxDim, quality) {
    maxDim = maxDim || 1280;
    quality = quality || 0.72;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Image illisible"));
        img.onload = () => {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- Systèmes ITE (isolant + finition) ----------

  const ISOLANT_LABELS = {
    pse: "Polystyrène (PSE)",
    laine_roche: "Laine de roche",
    mousse_pu: "Mousse PU",
    aucun: "Aucun (ravalement seul)",
  };

  const FINITION_LABELS = {
    enduit_rpe: "Enduit RPE",
    bardage: "Bardage",
    ravalement_antifissures: "Ravalement antifissures",
    ravalement_simple: "Ravalement simple",
  };

  const FINITIONS_BY_ISOLANT = {
    pse: ["enduit_rpe"],
    laine_roche: ["enduit_rpe", "bardage"],
    mousse_pu: ["bardage"],
    aucun: ["ravalement_antifissures", "ravalement_simple"],
  };

  function defaultSysteme() {
    return { isolant: "pse", finition: "enduit_rpe", bardageType: "" };
  }

  function systemeLabel(sys) {
    if (!sys) sys = defaultSysteme();
    let label = `${ISOLANT_LABELS[sys.isolant]} + ${FINITION_LABELS[sys.finition]}`;
    if (sys.finition === "bardage" && sys.bardageType) label += ` (${sys.bardageType})`;
    return label;
  }

  // ---------- Éléments complémentaires (sujétions) ----------

  const EXTRAS_CATALOG = [
    { key: "peinture_corniche", label: "Peinture Corniche", unit: "unité" },
    { key: "peinture_garde_corps", label: "Peinture Garde-corps", unit: "unité" },
    { key: "electricite_genante", label: "Électricité gênante", unit: "unité" },
    { key: "degrossi", label: "Dégrossi", unit: "m²" },
    { key: "rpe", label: "RPE", unit: "m²" },
    { key: "tuyaux_descente", label: "Tuyaux de descente", unit: "ml" },
    { key: "grille_ventilation", label: "Grille de ventilation", unit: "unité" },
    { key: "cales_stores", label: "Cales pour stores", unit: "unité" },
    { key: "bloque_volets", label: "Bloque volets", unit: "unité" },
    { key: "convertine_simple", label: "Convertine simple", unit: "ml" },
    { key: "convertine_chevronieres", label: "Convertine sur chevronières", unit: "ml" },
    { key: "peinture_sous_balcon", label: "Peinture sous balcon", unit: "unité" },
    { key: "peinture_casquette", label: "Peinture sur casquette de façade", unit: "unité" },
    { key: "peinture_tete_cheminee", label: "Peinture tête de cheminée", unit: "unité" },
    { key: "luminaire", label: "Luminaires", unit: "unité" },
    { key: "point_eau_rallonge", label: "Point d'eau à rallonger", unit: "unité" },
  ];

  const DEFAULT_TVA = 10;

  function defaultClientPrix() {
    return {
      m2: { prix: 0, tva: DEFAULT_TVA },
      tableau: { prix: 0, tva: DEFAULT_TVA },
      appui: { prix: 0, tva: DEFAULT_TVA },
    };
  }

  function getPrixEntry(client, field) {
    if (!client.prix) client.prix = defaultClientPrix();
    let e = client.prix[field];
    if (typeof e === "number") e = { prix: e, tva: DEFAULT_TVA };
    if (!e) e = { prix: 0, tva: DEFAULT_TVA };
    if (e.tva === undefined) e.tva = DEFAULT_TVA;
    client.prix[field] = e;
    return e;
  }

  // Les éléments complémentaires sont rattachés à chaque façade (`facade.extras`).
  function getExtraEntry(facade, key) {
    if (!facade.extras) facade.extras = {};
    let e = facade.extras[key];
    if (typeof e === "number") e = { qty: e, prix: 0, tva: DEFAULT_TVA };
    if (!e) e = { qty: 0, prix: 0, tva: DEFAULT_TVA };
    if (e.tva === undefined) e.tva = DEFAULT_TVA;
    facade.extras[key] = e;
    return e;
  }

  // Éléments complémentaires "autres" saisis librement par l'utilisateur (hors catalogue),
  // rattachés à chaque façade (`facade.customExtras`).
  function getFacadeCustomExtras(facade) {
    if (!facade.customExtras) facade.customExtras = [];
    return facade.customExtras;
  }

  function htTtc(ht, tva) {
    return { ht, ttc: ht * (1 + (tva || 0) / 100) };
  }

  function computeFacadeExtrasTotals(facade) {
    let ht = 0, ttc = 0;
    for (const item of EXTRAS_CATALOG) {
      const e = getExtraEntry(facade, item.key);
      const lineHt = (e.qty || 0) * (e.prix || 0);
      const line = htTtc(lineHt, e.tva);
      ht += line.ht;
      ttc += line.ttc;
    }
    // Les zones "autre" (prix personnalisé) dessinées au croquis sont facturées ici aussi.
    for (const z of (facade.zones || [])) {
      if (z.kind !== "autre") continue;
      const lineHt = zoneArea(z) * (z.prix || 0);
      const line = htTtc(lineHt, z.tva);
      ht += line.ht;
      ttc += line.ttc;
    }
    // Éléments complémentaires "autres" saisis librement (hors catalogue fixe).
    for (const ex of getFacadeCustomExtras(facade)) {
      const lineHt = (ex.qty || 0) * (ex.prix || 0);
      const line = htTtc(lineHt, ex.tva);
      ht += line.ht;
      ttc += line.ttc;
    }
    return { ht, ttc };
  }

  function computeClientExtrasTotals(client) {
    let ht = 0, ttc = 0;
    for (const f of client.facades) {
      const t = computeFacadeExtrasTotals(f);
      ht += t.ht;
      ttc += t.ttc;
    }
    return { ht, ttc };
  }

  function computeIteTotals(client) {
    const t = computeClientTotals(client);
    const m2 = getPrixEntry(client, "m2");
    const tab = getPrixEntry(client, "tableau");
    const app = getPrixEntry(client, "appui");

    const lineM2 = htTtc(t.nette * (m2.prix || 0), m2.tva);
    const lineTab = htTtc(t.tableau * (tab.prix || 0), tab.tva);
    const lineApp = htTtc(t.appui * (app.prix || 0), app.tva);

    return {
      ht: lineM2.ht + lineTab.ht + lineApp.ht,
      ttc: lineM2.ttc + lineTab.ttc + lineApp.ttc,
    };
  }

  function computeGrandTotals(client) {
    const ite = computeIteTotals(client);
    const extras = computeClientExtrasTotals(client);
    const iti = computeItiWorkTotals(client);
    const itiExtras = computeItiExtrasTotals(client);
    return {
      ht: ite.ht + extras.ht + iti.ht + itiExtras.ht,
      ttc: ite.ttc + extras.ttc + iti.ttc + itiExtras.ttc,
    };
  }

  // ---------- Intérieur (ITI) : zones -> postes de travaux -> cotes + éléments complémentaires ----------
  // Suggestions de types de postes : voir la <datalist id="iti-poste-suggestions"> dans index.html.

  const ISOLANT_ITI_LABELS = {
    laine_verre: "Laine de Verre",
    laine_roche: "Laine de roche",
    laine_bois: "Laine de bois",
    autre: "Autre",
  };

  // Catalogue de suggestions pour les éléments complémentaires d'un poste ITI.
  // "hasTaille" : l'élément nécessite de préciser une taille (ex: dimension de porte/trappe).
  const ITI_EXTRAS_CATALOG = [
    { key: "demolition", label: "Démolition", unit: "m²" },
    { key: "enlevement", label: "Enlèvement", unit: "m²" },
    { key: "membrane", label: "Membrane", unit: "m²" },
    { key: "velux", label: "Velux", unit: "unité" },
    { key: "habillage_velux", label: "Habillage de velux", unit: "unité" },
    { key: "lucarne", label: "Lucarne", unit: "unité" },
    { key: "placo_hydro", label: "Placo Hydro", unit: "m²" },
    { key: "wc_suspendus", label: "WC Suspendus", unit: "unité" },
    { key: "coffrage_coupe_feu", label: "Coffrage Coupe Feu", unit: "unité" },
    { key: "chemin_acces_vmc", label: "Chemin d'accès VMC", unit: "ml" },
    { key: "deflecteurs", label: "Déflecteurs", unit: "ml" },
    { key: "coiffe_spots", label: "Coiffe Pour Spots", unit: "unité" },
    { key: "trappe_isolee", label: "Trappe d'accès isolée", unit: "unité", hasTaille: true },
    { key: "trappe_non_isolee", label: "Trappe d'accès non isolée", unit: "unité" },
    { key: "protection_mobilier", label: "Protection du mobilier", unit: "unité" },
    { key: "porte_isolee_pg", label: "Porte isolée PG", unit: "unité", hasTaille: true },
    { key: "porte_isolee_pd", label: "Porte isolée PD", unit: "unité", hasTaille: true },
    { key: "porte_alveolaire_pd", label: "Porte alvéolaire PD", unit: "unité", hasTaille: true },
    { key: "porte_alveolaire_pg", label: "Porte alvéolaire PG", unit: "unité", hasTaille: true },
  ];

  function defaultClientIti() {
    return { zones: [] };
  }

  function getClientIti(client) {
    if (!client.iti) client.iti = defaultClientIti();
    if (!client.iti.zones) client.iti.zones = [];
    return client.iti;
  }

  function computeMesureArea(m) {
    return (m.largeur || 0) * (m.hauteur || 0) * (m.qty || 1);
  }

  // Ouvertures ITI : pas d'appui séparé comme en ITE, tout est dans le linteau (habillage).
  // Fenêtre = 4 côtés, Porte = 3 côtés (pas de sol), Velux = pas de linteau (forfait manuel "Habillage de velux").
  const ITI_OPENING_LABELS = { fenetre: "Fenêtre", porte: "Porte", velux: "Velux" };

  function computePosteOpening(o) {
    const surface = (o.largeur || 0) * (o.hauteur || 0) * (o.qty || 1);
    let linteau = 0;
    if (o.type === "fenetre") linteau = 2 * (o.largeur + o.hauteur) * o.qty;
    else if (o.type === "porte") linteau = (2 * o.hauteur + o.largeur) * o.qty;
    return { surface, linteau };
  }

  function computePoste(poste) {
    const surfaceBrute = (poste.mesures || []).reduce((sum, m) => sum + computeMesureArea(m), 0);

    let ouvSurface = 0, linteauTotal = 0;
    for (const o of (poste.ouvertures || [])) {
      const oc = computePosteOpening(o);
      ouvSurface += oc.surface;
      linteauTotal += oc.linteau;
    }
    const surface = Math.max(0, surfaceBrute - ouvSurface);

    const main = htTtc(surface * (poste.prix || 0), poste.tva);
    const linteauLine = htTtc(linteauTotal * (poste.prixLinteau || 0), poste.tva);

    let extrasHt = 0, extrasTtc = 0;
    for (const ex of (poste.extras || [])) {
      const lineHt = (ex.qty || 0) * (ex.prix || 0);
      const line = htTtc(lineHt, ex.tva);
      extrasHt += line.ht;
      extrasTtc += line.ttc;
    }

    return {
      surfaceBrute,
      ouvSurface,
      surface,
      linteauTotal,
      mainHt: main.ht + linteauLine.ht,
      mainTtc: main.ttc + linteauLine.ttc,
      extrasHt,
      extrasTtc,
      totalHt: main.ht + linteauLine.ht + extrasHt,
      totalTtc: main.ttc + linteauLine.ttc + extrasTtc,
    };
  }

  function computeZoneIti(zone) {
    let ht = 0, ttc = 0, mainHt = 0, mainTtc = 0, extrasHt = 0, extrasTtc = 0;
    for (const poste of (zone.postes || [])) {
      const c = computePoste(poste);
      ht += c.totalHt; ttc += c.totalTtc;
      mainHt += c.mainHt; mainTtc += c.mainTtc;
      extrasHt += c.extrasHt; extrasTtc += c.extrasTtc;
    }
    return { ht, ttc, mainHt, mainTtc, extrasHt, extrasTtc };
  }

  function computeItiWorkTotals(client) {
    let ht = 0, ttc = 0;
    for (const zone of getClientIti(client).zones) {
      const c = computeZoneIti(zone);
      ht += c.mainHt;
      ttc += c.mainTtc;
    }
    return { ht, ttc };
  }

  function computeItiExtrasTotals(client) {
    let ht = 0, ttc = 0;
    for (const zone of getClientIti(client).zones) {
      const c = computeZoneIti(zone);
      ht += c.extrasHt;
      ttc += c.extrasTtc;
    }
    return { ht, ttc };
  }

  function computeItiTotals(client) {
    const work = computeItiWorkTotals(client);
    const extras = computeItiExtrasTotals(client);
    return { ht: work.ht + extras.ht, ttc: work.ttc + extras.ttc };
  }

  // Migration : les éléments complémentaires étaient globaux au client avant d'être rattachés aux façades.
  function migrateClientExtras(client) {
    if (client.extras && Object.keys(client.extras).length > 0 && client.facades.length > 0) {
      const target = client.facades[0];
      if (!target.extras) target.extras = {};
      for (const key of Object.keys(client.extras)) {
        if (!target.extras[key]) target.extras[key] = client.extras[key];
      }
      delete client.extras;
      Store.upsertClient(client);
    }
  }

  let storageWarned = false;
  function warnStorageUnavailable() {
    if (storageWarned) return;
    storageWarned = true;
    const banner = document.createElement("div");
    banner.textContent = "⚠ Sauvegarde impossible sur cet appareil/navigateur : vos fiches ne seront pas conservées après fermeture de la page. Essayez d'ouvrir la page dans Chrome (hors navigation privée), ou via une adresse http:// plutôt qu'un fichier local.";
    banner.style.cssText = "position:sticky;top:0;z-index:100;background:#fdeaea;color:#8a1f1f;padding:12px 16px;border-radius:10px;margin-bottom:14px;font-size:0.9rem;font-weight:600;";
    document.getElementById("app").prepend(banner);
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function fmt(n, unit) {
    return round2(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + unit;
  }

  // ---------- Calculs ----------

  const OPENING_TYPES = {
    fenetre: { label: "Fenêtre", tag: "tag-fenetre", hasAppui: true },
    porte: { label: "Porte", tag: "tag-porte", hasAppui: false },
    baie_vitree: { label: "Baie vitrée", tag: "tag-baie", hasAppui: false },
    baie_vitree_simple: { label: "Baie vitrée simple", tag: "tag-baie-simple", hasAppui: false },
  };

  function computeOpening(o) {
    const surface = o.largeur * o.hauteur * o.qty;
    const tableau = (2 * o.hauteur + o.largeur) * o.qty;
    const appui = OPENING_TYPES[o.type].hasAppui ? o.largeur * o.qty : 0;
    return { surface, tableau, appui };
  }

  function zoneArea(z) {
    if (z.type === "polygone") return z.area || 0;
    return z.type === "triangle" ? (z.width * z.height) / 2 : z.width * z.height;
  }

  // Chaque zone dessinée dans le croquis (rectangle ou triangle) s'additionne ou se
  // déduit de la surface de façade — plusieurs zones permettent les formes complexes
  // (pignons, décrochés...). Une zone "autre" est en plus facturée à part (prix propre).
  function computeFacadeZonesBrute(f) {
    if (f.zones && f.zones.length > 0) {
      let brute = 0;
      for (const z of f.zones) {
        const a = zoneArea(z);
        brute += z.kind === "ajout" ? a : -a;
      }
      return Math.max(0, brute);
    }
    // Compatibilité avec les anciennes façades définies par largeur × hauteur unique.
    return (f.largeur || 0) * (f.hauteur || 0);
  }

  function computeFacade(f) {
    const brute = computeFacadeZonesBrute(f);
    let ouvSurface = 0, tableau = 0, appui = 0;
    for (const o of f.ouvertures) {
      const c = computeOpening(o);
      ouvSurface += c.surface;
      tableau += c.tableau;
      appui += c.appui;
    }
    const nette = Math.max(0, brute - ouvSurface);
    return { brute, ouvSurface, nette, tableau, appui };
  }

  function computeClientTotals(client) {
    let nette = 0, tableau = 0, appui = 0;
    for (const f of client.facades) {
      const c = computeFacade(f);
      nette += c.nette;
      tableau += c.tableau;
      appui += c.appui;
    }
    return { nette, tableau, appui };
  }

  // ---------- Store ----------

  const Store = {
    data: [],
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        this.data = raw ? JSON.parse(raw) : [];
      } catch (e) {
        console.error("Erreur de lecture du stockage local", e);
        this.data = [];
      }
    },
    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
        return true;
      } catch (e) {
        console.error("Erreur d'écriture du stockage local", e);
        warnStorageUnavailable();
        return false;
      }
    },
    getClient(id) {
      return this.data.find((c) => c.id === id);
    },
    upsertClient(client) {
      const idx = this.data.findIndex((c) => c.id === client.id);
      if (idx >= 0) this.data[idx] = client; else this.data.push(client);
      this.save();
      pushClientToFirestore(client);
    },
    deleteClient(id) {
      this.data = this.data.filter((c) => c.id !== id);
      this.save();
      deleteClientFromFirestore(id);
    },
  };

  Store.load();

  // ---------- Synchronisation Firestore (users/{uid}/clients/{clientId}) ----------
  // Le stockage local reste la source instantanée (démarrage hors-ligne immédiat) ; Firestore
  // synchronise en tâche de fond dès qu'un compte est connecté et qu'il y a du réseau.

  let currentUid = null;
  let firestoreUnsub = null;

  function clientsCollection(uid) {
    return db.collection("users").doc(uid).collection("clients");
  }

  // ---------- Photos et croquis : sous-collection séparée ----------
  // Un document Firestore est limité à 1 Mo. Les photos (et croquis dessinés) sont assez
  // volumineuses pour dépasser cette limite dès qu'un client en a plusieurs, ce qui faisait
  // échouer silencieusement toute la sauvegarde du client (texte compris) sur Firestore : le
  // client restait alors visible seulement sur l'appareil où il avait été créé/modifié. Les
  // médias (dataUrl) sont donc stockés à part, un document par photo/croquis, et le document
  // client principal ne garde que les identifiants — le modèle local (localStorage) ne change
  // pas, il garde toujours les dataUrl complètes.
  function mediaCollection(uid, clientId) {
    return clientsCollection(uid).doc(clientId).collection("media");
  }

  // Parcourt un objet "client" (ou un clone / une version reçue de Firestore) et retourne une
  // référence {id, get, set} pour chaque emplacement de média (croquis de façade, photos de
  // façade, photos de mesure ITI), afin de traiter la lecture/écriture de façon uniforme.
  function collectMediaRefs(client) {
    const refs = [];
    for (const f of client.facades || []) {
      refs.push({ id: "sketch_" + f.id, get: () => f.sketch, set: (v) => { f.sketch = v; } });
      for (const p of f.photos || []) {
        refs.push({ id: p.id, get: () => p.dataUrl, set: (v) => { p.dataUrl = v; } });
      }
    }
    for (const zone of (client.iti && client.iti.zones) || []) {
      for (const poste of zone.postes || []) {
        for (const m of poste.mesures || []) {
          for (const p of m.photos || []) {
            refs.push({ id: p.id, get: () => p.dataUrl, set: (v) => { p.dataUrl = v; } });
          }
        }
      }
    }
    return refs;
  }

  function stripMediaFromPayload(payload) {
    for (const ref of collectMediaRefs(payload)) ref.set(null);
  }

  // Mémorise, pour chaque média déjà envoyé, la dataUrl envoyée en dernier — pour ne
  // réenvoyer un média que s'il a réellement changé (et non à chaque frappe clavier ailleurs
  // dans la fiche).
  const syncedMediaValues = new Map(); // mediaId -> dataUrl envoyée

  function uploadClientMedia(uid, client) {
    const col = mediaCollection(uid, client.id);
    const tasks = [];
    for (const ref of collectMediaRefs(client)) {
      const value = ref.get();
      if (!value || syncedMediaValues.get(ref.id) === value) continue;
      tasks.push(
        col.doc(ref.id).set({ dataUrl: value }).then(() => {
          syncedMediaValues.set(ref.id, value);
        })
      );
    }
    return Promise.all(tasks);
  }

  // Avant de remplacer un client local par une version reçue de Firestore (plus récente), on
  // récupère d'abord les dataUrl déjà connues localement (cas normal : le média a été ajouté
  // sur cet appareil) pour ne pas les perdre. Ce qui reste manquant (média ajouté sur un autre
  // appareil) sera récupéré séparément depuis la sous-collection "media".
  function hydrateMediaFromLocal(remoteClient, previousLocalClient) {
    const localValues = new Map();
    if (previousLocalClient) {
      for (const ref of collectMediaRefs(previousLocalClient)) {
        const v = ref.get();
        if (v) localValues.set(ref.id, v);
      }
    }
    const missing = [];
    for (const ref of collectMediaRefs(remoteClient)) {
      if (ref.get()) continue;
      const cached = localValues.get(ref.id);
      if (cached) ref.set(cached);
      else missing.push(ref.id);
    }
    return missing;
  }

  function fetchMissingMedia(uid, clientId, mediaIds) {
    if (!mediaIds.length) return;
    const col = mediaCollection(uid, clientId);
    mediaIds.forEach((mediaId) => {
      col.doc(mediaId).get().then((snap) => {
        if (!snap.exists) return;
        const dataUrl = snap.data().dataUrl;
        const client = Store.getClient(clientId);
        if (!client) return;
        let found = false;
        for (const ref of collectMediaRefs(client)) {
          if (ref.id === mediaId && !ref.get()) { ref.set(dataUrl); found = true; }
        }
        if (found) {
          syncedMediaValues.set(mediaId, dataUrl);
          Store.save();
          refreshCurrentView();
        }
      }).catch((err) => console.error("Échec de récupération d'une photo/croquis", err));
    });
  }

  // Les champs texte (nom, notes, adresse...) se sauvegardent en local à chaque frappe
  // (persistClientFields), ce qui déclencherait sinon un envoi Firestore complet du document
  // (photos comprises) à chaque caractère tapé. On regroupe donc ces envois : le document
  // n'est réellement poussé en ligne que ~1s après la dernière modification, avec l'état le
  // plus à jour au moment de l'envoi (voir Store.getClient dans le timer).
  const FIRESTORE_PUSH_DELAY = 1000;
  const pendingFirestorePushes = new Map(); // clientId -> timer

  function sendClientToFirestore(client) {
    if (!currentUid) return;
    const uid = currentUid;
    // Passe par JSON pour éliminer les éventuels champs `undefined` (Firestore les refuse,
    // contrairement à JSON.stringify utilisé pour le stockage local) et pour obtenir un clone
    // qu'on peut dépouiller des médias sans toucher à l'objet client local.
    const payload = JSON.parse(JSON.stringify(client));
    stripMediaFromPayload(payload);
    uploadClientMedia(uid, client).catch((err) => {
      console.error("Échec de synchronisation des photos/croquis", err);
    });
    return clientsCollection(uid).doc(client.id).set(payload).catch((err) => {
      console.error("Échec de synchronisation (sauvegarde en ligne)", err);
      showSyncWarning("⚠ Cette fiche n'a pas pu être synchronisée en ligne (pas de réseau, ou trop de photos/données). Elle reste sauvegardée sur cet appareil.");
    });
  }

  function pushClientToFirestore(client) {
    if (!currentUid) return;
    const clientId = client.id;
    const existing = pendingFirestorePushes.get(clientId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingFirestorePushes.delete(clientId);
      const latest = Store.getClient(clientId);
      if (latest) sendClientToFirestore(latest);
    }, FIRESTORE_PUSH_DELAY);
    pendingFirestorePushes.set(clientId, timer);
  }

  // Si l'onglet se ferme ou passe en arrière-plan avant la fin du délai ci-dessus, on envoie
  // immédiatement les fiches en attente plutôt que de risquer de perdre la dernière saisie.
  function flushPendingFirestorePushes() {
    for (const [clientId, timer] of pendingFirestorePushes) {
      clearTimeout(timer);
      pendingFirestorePushes.delete(clientId);
      const latest = Store.getClient(clientId);
      if (latest) sendClientToFirestore(latest);
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingFirestorePushes();
  });
  window.addEventListener("pagehide", flushPendingFirestorePushes);

  function deleteClientFromFirestore(id) {
    if (!currentUid) return;
    const uid = currentUid;
    mediaCollection(uid, id).get().then((snap) => {
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      return batch.commit();
    }).catch((err) => console.error("Échec de suppression des photos/croquis en ligne", err));
    clientsCollection(uid).doc(id).delete().catch((err) => {
      console.error("Échec de synchronisation (suppression en ligne)", err);
    });
  }

  function refreshCurrentView() {
    if (!viewClients.hidden) renderClientList();
    else if (!viewClient.hidden && currentClientId) renderClientView();
  }

  function startFirestoreSync(uid) {
    stopFirestoreSync();
    currentUid = uid;
    const col = clientsCollection(uid);
    let initialSyncDone = false;

    firestoreUnsub = col.onSnapshot((snapshot) => {
      let changed = false;
      snapshot.docChanges().forEach((change) => {
        if (change.type === "removed") {
          const idx = Store.data.findIndex((c) => c.id === change.doc.id);
          if (idx >= 0) { Store.data.splice(idx, 1); changed = true; }
          return;
        }
        const remote = change.doc.data();
        const local = Store.getClient(change.doc.id);
        if (!local || (remote.updatedAt || 0) > (local.updatedAt || 0)) {
          const missingMedia = hydrateMediaFromLocal(remote, local);
          const idx = Store.data.findIndex((c) => c.id === change.doc.id);
          if (idx >= 0) Store.data[idx] = remote; else Store.data.push(remote);
          changed = true;
          if (missingMedia.length) fetchMissingMedia(uid, change.doc.id, missingMedia);
        }
      });
      if (changed) {
        Store.save();
        refreshCurrentView();
      }
      if (!initialSyncDone) {
        initialSyncDone = true;
        // Pousse en ligne les fiches créées hors-ligne avant la première connexion.
        const remoteIds = new Set(snapshot.docs.map((d) => d.id));
        for (const client of Store.data) {
          if (!remoteIds.has(client.id)) pushClientToFirestore(client);
        }
      }
    }, (err) => {
      console.error("Erreur de synchronisation Firestore", err);
      showSyncWarning("⚠ Synchronisation en ligne indisponible (pas de réseau). Tes données restent accessibles sur cet appareil.");
    });
  }

  function stopFirestoreSync() {
    if (firestoreUnsub) { firestoreUnsub(); firestoreUnsub = null; }
    currentUid = null;
  }

  // ---------- State ----------

  let currentClientId = null;

  // ---------- DOM refs ----------

  const viewAuth = document.getElementById("view-auth");
  const authEmailInput = document.getElementById("auth-email");
  const authPasswordInput = document.getElementById("auth-password");
  const authErrorEl = document.getElementById("auth-error");
  const authSigninBtn = document.getElementById("auth-signin");
  const authSignupBtn = document.getElementById("auth-signup");
  const authResetBtn = document.getElementById("auth-reset");
  const authUserEmailEl = document.getElementById("auth-user-email");
  const btnSignOut = document.getElementById("btn-sign-out");

  const syncBannerEl = document.getElementById("sync-banner");
  const syncBannerTextEl = document.getElementById("sync-banner-text");
  const syncBannerCloseEl = document.getElementById("sync-banner-close");

  const viewClients = document.getElementById("view-clients");
  const viewClient = document.getElementById("view-client");
  const clientListEl = document.getElementById("client-list");
  const emptyClientsEl = document.getElementById("empty-clients");
  const clientSearch = document.getElementById("client-search");

  const clientTitle = document.getElementById("client-title");
  const fNom = document.getElementById("f-nom");
  const fPrenom = document.getElementById("f-prenom");
  const fAdresseChantier = document.getElementById("f-adresse-chantier");
  const fAdresseFacturation = document.getElementById("f-adresse-facturation");
  const fCodePostal = document.getElementById("f-code-postal");
  const fTel = document.getElementById("f-tel");
  const fEmail = document.getElementById("f-email");
  const fDateVisite = document.getElementById("f-date-visite");
  const fNotes = document.getElementById("f-notes");
  const fM2Habitable = document.getElementById("f-m2-habitable");
  const fAnneeConstruction = document.getElementById("f-annee-construction");
  const fSystemeChauffage = document.getElementById("f-systeme-chauffage");
  const fPersonnesCharge = document.getElementById("f-personnes-charge");
  const fRfr = document.getElementById("f-rfr");
  const fTypeAides = document.getElementById("f-type-aides");

  document.querySelectorAll(".form-collapsible-toggle").forEach((btn) => {
    const body = document.getElementById(btn.dataset.toggleTarget);
    const chevron = btn.querySelector(".chevron");
    btn.addEventListener("click", () => {
      body.hidden = !body.hidden;
      chevron.textContent = body.hidden ? "▸" : "▾";
    });
  });

  const facadeListEl = document.getElementById("facade-list");
  const emptyFacadesEl = document.getElementById("empty-facades");
  const expandedFacadeExtras = new Set();

  const tabExterieurBtn = document.getElementById("tab-exterieur");
  const tabInterieurBtn = document.getElementById("tab-interieur");
  const sectionExterieurEl = document.getElementById("section-exterieur");
  const sectionInterieurEl = document.getElementById("section-interieur");
  let activeSection = "exterieur";

  const itiZoneListEl = document.getElementById("iti-zone-list");
  const emptyItiZonesEl = document.getElementById("empty-iti-zones");
  const expandedPosteExtras = new Set();
  const totalItiHtEl = document.getElementById("total-iti-ht");
  const totalItiTtcEl = document.getElementById("total-iti-ttc");
  const totalItiExtrasHtEl = document.getElementById("total-iti-extras-ht");
  const totalItiExtrasTtcEl = document.getElementById("total-iti-extras-ttc");

  const totSurface = document.getElementById("tot-surface");
  const totTableaux = document.getElementById("tot-tableaux");
  const totAppuis = document.getElementById("tot-appuis");

  const priceM2Input = document.getElementById("price-m2");
  const priceTableauInput = document.getElementById("price-tableau");
  const priceAppuiInput = document.getElementById("price-appui");
  const tvaM2Input = document.getElementById("tva-m2");
  const tvaTableauInput = document.getElementById("tva-tableau");
  const tvaAppuiInput = document.getElementById("tva-appui");
  const subtotalM2HtEl = document.getElementById("subtotal-m2-ht");
  const subtotalM2TtcEl = document.getElementById("subtotal-m2-ttc");
  const subtotalTableauHtEl = document.getElementById("subtotal-tableau-ht");
  const subtotalTableauTtcEl = document.getElementById("subtotal-tableau-ttc");
  const subtotalAppuiHtEl = document.getElementById("subtotal-appui-ht");
  const subtotalAppuiTtcEl = document.getElementById("subtotal-appui-ttc");
  const totalIteHtEl = document.getElementById("total-ite-ht");
  const totalIteTtcEl = document.getElementById("total-ite-ttc");
  const totalExtrasHtEl = document.getElementById("total-extras-ht");
  const totalExtrasTtcEl = document.getElementById("total-extras-ttc");
  const grandTotalHtEl = document.getElementById("grand-total-ht");
  const grandTotalTtcEl = document.getElementById("grand-total-ttc");

  const modalOverlay = document.getElementById("modal-overlay");
  const modalTitle = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-body");
  const modalCancel = document.getElementById("modal-cancel");
  const modalSave = document.getElementById("modal-save");

  const photoInputEl = document.getElementById("photo-input");
  const photoLightboxEl = document.getElementById("photo-lightbox");
  const photoLightboxImgEl = document.getElementById("photo-lightbox-img");
  const photoLightboxCloseEl = document.getElementById("photo-lightbox-close");
  const photoLightboxDeleteEl = document.getElementById("photo-lightbox-delete");
  const printAreaEl = document.getElementById("print-area");

  // ---------- Bandeau d'alerte de synchronisation ----------

  function showSyncWarning(msg) {
    syncBannerTextEl.textContent = msg;
    syncBannerEl.hidden = false;
  }

  syncBannerCloseEl.addEventListener("click", () => { syncBannerEl.hidden = true; });

  // ---------- Connexion (email / mot de passe) ----------

  const AUTH_ERROR_MESSAGES = {
    "auth/invalid-email": "Adresse email invalide.",
    "auth/user-not-found": "Aucun compte avec cet email.",
    "auth/wrong-password": "Mot de passe incorrect.",
    "auth/invalid-credential": "Email ou mot de passe incorrect.",
    "auth/email-already-in-use": "Un compte existe déjà avec cet email. Clique \"Se connecter\".",
    "auth/weak-password": "Mot de passe trop court (6 caractères minimum).",
    "auth/network-request-failed": "Pas de connexion internet. Réessaie plus tard.",
    "auth/missing-password": "Merci de renseigner un mot de passe.",
  };

  function authErrorMessage(err) {
    return AUTH_ERROR_MESSAGES[err.code] || ("Erreur : " + err.message);
  }

  function setAuthError(msg) {
    authErrorEl.textContent = msg;
    authErrorEl.hidden = !msg;
  }

  authSigninBtn.addEventListener("click", () => {
    setAuthError("");
    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value;
    if (!email || !password) { setAuthError("Renseigne ton email et ton mot de passe."); return; }
    authSigninBtn.disabled = true;
    auth.signInWithEmailAndPassword(email, password)
      .catch((err) => setAuthError(authErrorMessage(err)))
      .finally(() => { authSigninBtn.disabled = false; });
  });

  authSignupBtn.addEventListener("click", () => {
    setAuthError("");
    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value;
    if (!email || !password) { setAuthError("Renseigne un email et un mot de passe (6 caractères minimum)."); return; }
    authSignupBtn.disabled = true;
    auth.createUserWithEmailAndPassword(email, password)
      .catch((err) => setAuthError(authErrorMessage(err)))
      .finally(() => { authSignupBtn.disabled = false; });
  });

  authResetBtn.addEventListener("click", () => {
    setAuthError("");
    const email = authEmailInput.value.trim();
    if (!email) { setAuthError("Renseigne ton email ci-dessus, puis clique à nouveau sur ce lien."); return; }
    auth.sendPasswordResetEmail(email)
      .then(() => setAuthError("Email de réinitialisation envoyé. Vérifie ta boîte mail."))
      .catch((err) => setAuthError(authErrorMessage(err)));
  });

  btnSignOut.addEventListener("click", () => {
    if (confirm("Se déconnecter de cet appareil ?")) auth.signOut();
  });

  auth.onAuthStateChanged((user) => {
    if (user) {
      viewAuth.hidden = true;
      authUserEmailEl.textContent = user.email || "";
      authPasswordInput.value = "";
      setAuthError("");
      startFirestoreSync(user.uid);
      showClientsView();
    } else {
      stopFirestoreSync();
      viewClients.hidden = true;
      viewClient.hidden = true;
      viewAuth.hidden = false;
    }
  });

  // ---------- Navigation ----------

  function showClientsView() {
    currentClientId = null;
    viewClient.hidden = true;
    viewClients.hidden = false;
    renderClientList();
  }

  function showClientView(id) {
    currentClientId = id;
    viewClients.hidden = true;
    viewClient.hidden = false;
    setActiveSection("exterieur");
    renderClientView();
  }

  // ---------- Render: liste clients ----------

  function renderClientList() {
    const term = clientSearch.value.trim().toLowerCase();
    const clients = [...Store.data]
      .filter((c) => !term
        || clientFullName(c).toLowerCase().includes(term)
        || clientAdresseChantier(c).toLowerCase().includes(term))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    clientListEl.innerHTML = "";
    emptyClientsEl.hidden = clients.length > 0;

    for (const c of clients) {
      const totals = computeClientTotals(c);
      const adresse = clientAdresseChantier(c);
      const dateVisite = clientDateVisite(c);
      const div = document.createElement("div");
      div.className = "client-item";
      div.innerHTML = `
        <div>
          <div class="ci-name">${escapeHtml(clientFullName(c))}</div>
          <div class="ci-sub">${escapeHtml(adresse || "Adresse non renseignée")}${dateVisite ? " · Visite technique " + formatDate(dateVisite) : ""}</div>
          <div class="ci-sub">${fmt(totals.nette, "m²")} nette · ${c.facades.length} façade(s)</div>
        </div>
        <div class="ci-arrow">›</div>
      `;
      div.addEventListener("click", () => showClientView(c.id));
      clientListEl.appendChild(div);
    }
  }

  function formatDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Nom affiché : "Prénom Nom". Compatible avec les fiches créées avant la séparation
  // nom/prénom (client.nom contenait alors le nom complet, client.prenom est vide).
  function clientFullName(client) {
    const parts = [client.prenom, client.nom].map((s) => (s || "").trim()).filter(Boolean);
    return parts.join(" ") || "(Sans nom)";
  }

  // Compatibilité : anciennes fiches avec `adresse`/`dateRdv` avant le renommage en
  // `adresseChantier`/`dateVisiteTechnique`.
  function clientAdresseChantier(client) {
    return client.adresseChantier || client.adresse || "";
  }

  function clientDateVisite(client) {
    return client.dateVisiteTechnique || client.dateRdv || "";
  }

  // ---------- Render: fiche client ----------

  function renderClientView() {
    const client = Store.getClient(currentClientId);
    if (!client) { showClientsView(); return; }

    migrateClientExtras(client);

    clientTitle.textContent = clientFullName(client) !== "(Sans nom)" ? clientFullName(client) : "Nouvelle fiche client";
    fNom.value = client.nom || "";
    fPrenom.value = client.prenom || "";
    fAdresseChantier.value = clientAdresseChantier(client);
    fAdresseFacturation.value = client.adresseFacturation || "";
    fCodePostal.value = client.codePostal || "";
    fTel.value = client.telephone || "";
    fEmail.value = client.email || "";
    fDateVisite.value = clientDateVisite(client);
    fNotes.value = client.notes || "";
    fM2Habitable.value = client.m2Habitable || "";
    fAnneeConstruction.value = client.anneeConstruction || "";
    fSystemeChauffage.value = client.systemeChauffage || "";
    fPersonnesCharge.value = client.personnesCharge || "";
    fRfr.value = client.rfr || "";
    fTypeAides.value = client.typeAides || "";

    renderFacadeList(client);
    renderItiZoneList(client);
    renderTotals(client);
  }

  function setActiveSection(section) {
    activeSection = section;
    sectionExterieurEl.hidden = section !== "exterieur";
    sectionInterieurEl.hidden = section !== "interieur";
    tabExterieurBtn.classList.toggle("active", section === "exterieur");
    tabInterieurBtn.classList.toggle("active", section === "interieur");
  }

  tabExterieurBtn.addEventListener("click", () => setActiveSection("exterieur"));
  tabInterieurBtn.addEventListener("click", () => setActiveSection("interieur"));

  const ZONE_KIND_LABELS = { ajout: "Ajout", deduit: "Déduit", autre: "Autre" };
  const ZONE_TYPE_ICONS = { rectangle: "▭", triangle: "🔺", polygone: "⬠" };

  function facadeZonesHtml(facade) {
    const zones = facade.zones || [];
    const addBtnHtml = `
      <div class="add-opening-row">
        <button class="btn btn-primary btn-small" data-action="add-zone-manual" data-facade-id="${facade.id}">+ Ajouter une côte à la main</button>
      </div>
    `;

    if (zones.length === 0) {
      // Façade legacy définie par largeur × hauteur avant l'introduction des zones : rien à afficher ici.
      if (facade.largeur > 0 && facade.hauteur > 0) return addBtnHtml;
      return `<p class="empty-msg zones-empty">⚠ Aucune zone définie — dessinez un rectangle ou un triangle dans le croquis, ou ajoutez une côte à la main.</p>${addBtnHtml}`;
    }

    const rows = zones.map((z) => {
      const area = zoneArea(z);
      const kindClass = z.kind === "ajout" ? "zone-kind-ajout" : z.kind === "deduit" ? "zone-kind-deduit" : "zone-kind-autre";
      const kindLabel = z.kind === "autre" ? `Autre : ${escapeHtml(z.label)}` : ZONE_KIND_LABELS[z.kind];
      const line = z.kind === "autre" ? htTtc(area * (z.prix || 0), z.tva) : null;
      return `
        <div class="zone-item">
          <div class="zone-info">
            <span class="tag ${kindClass}">${ZONE_TYPE_ICONS[z.type]} ${kindLabel}</span>
            ${z.type === "polygone" ? `Forme libre (croquis) — ${fmt(area, "m²")}` : `${z.width.toFixed(2)} × ${z.height.toFixed(2)} m — ${fmt(area, "m²")}`}
          </div>
          ${z.kind === "autre" ? `
          <div class="extra-price-controls">
            <label>Prix HT/m² (€)
              <input type="number" class="zone-price-input" inputmode="decimal" min="0" step="0.01" value="${z.prix}" data-facade-id="${facade.id}" data-zone-id="${z.id}">
            </label>
            <label>TVA (%)
              <input type="number" class="zone-tva-input" inputmode="decimal" min="0" max="100" step="0.1" value="${z.tva}" data-facade-id="${facade.id}" data-zone-id="${z.id}">
            </label>
            <span class="extra-subtotal">HT ${fmt(line.ht, "€")} / TTC ${fmt(line.ttc, "€")}</span>
          </div>` : ""}
          <button class="btn btn-ghost btn-small" data-action="edit-zone" data-facade-id="${facade.id}" data-zone-id="${z.id}">Modifier</button>
          <button class="btn btn-danger btn-small" data-action="delete-zone" data-facade-id="${facade.id}" data-zone-id="${z.id}">✕</button>
        </div>
      `;
    }).join("");

    return `<div class="zone-list">${rows}</div>${addBtnHtml}`;
  }

  function facadeExtrasHtml(facade) {
    const expanded = expandedFacadeExtras.has(facade.id);
    const customExtras = getFacadeCustomExtras(facade);
    const activeCount = EXTRAS_CATALOG.filter((item) => getExtraEntry(facade, item.key).qty > 0).length + customExtras.length;
    const totals = computeFacadeExtrasTotals(facade);

    const rows = EXTRAS_CATALOG.map((item) => {
      const e = getExtraEntry(facade, item.key);
      const line = htTtc((e.qty || 0) * (e.prix || 0), e.tva);
      return `
        <div class="extra-row ${e.qty > 0 ? "extra-row-active" : ""}">
          <div class="extra-label">${item.label} <span class="extra-unit">(${item.unit})</span></div>
          <div class="extra-qty-controls">
            <button type="button" class="btn btn-ghost btn-small" data-action="extra-dec" data-facade-id="${facade.id}" data-key="${item.key}">−</button>
            <input type="number" class="extra-qty-input" inputmode="decimal" min="0" step="${item.unit === "unité" ? "1" : "0.01"}" value="${e.qty}" data-facade-id="${facade.id}" data-key="${item.key}">
            <button type="button" class="btn btn-ghost btn-small" data-action="extra-inc" data-facade-id="${facade.id}" data-key="${item.key}">+</button>
          </div>
          <div class="extra-price-controls">
            <label>Prix HT/${item.unit} (€)
              <input type="number" class="extra-price-input" inputmode="decimal" min="0" step="0.01" value="${e.prix}" data-facade-id="${facade.id}" data-key="${item.key}">
            </label>
            <label>TVA (%)
              <input type="number" class="extra-tva-input" inputmode="decimal" min="0" max="100" step="0.1" value="${e.tva}" data-facade-id="${facade.id}" data-key="${item.key}">
            </label>
            <span class="extra-subtotal">HT ${fmt(line.ht, "€")} / TTC ${fmt(line.ttc, "€")}</span>
          </div>
        </div>
      `;
    }).join("");

    const customRows = customExtras.map((ex) => {
      const line = htTtc((ex.qty || 0) * (ex.prix || 0), ex.tva);
      return `
        <div class="zone-item">
          <div class="zone-info">${escapeHtml(ex.label)} (${escapeHtml(ex.unit)}) — ${ex.qty} × ${fmt(ex.prix, "€")} = HT ${fmt(line.ht, "€")} / TTC ${fmt(line.ttc, "€")}</div>
          <div class="opening-actions">
            <button class="btn btn-ghost btn-small" data-action="edit-facade-extra" data-facade-id="${facade.id}" data-extra-id="${ex.id}">Modifier</button>
            <button class="btn btn-danger btn-small" data-action="delete-facade-extra" data-facade-id="${facade.id}" data-extra-id="${ex.id}">✕</button>
          </div>
        </div>
      `;
    }).join("");

    return `
      <div class="facade-extras">
        <button type="button" class="facade-extras-toggle" data-action="toggle-extras" data-facade-id="${facade.id}">
          Éléments complémentaires${activeCount > 0 ? ` (${activeCount} actif${activeCount > 1 ? "s" : ""})` : ""} ${expanded ? "▾" : "▸"}
        </button>
        <div class="facade-extras-body" ${expanded ? "" : "hidden"}>
          ${rows}
          ${customRows}
          <div class="add-opening-row">
            <button class="btn btn-primary btn-small" data-action="add-facade-extra" data-facade-id="${facade.id}">+ Ajouter un élément "autre" (à remplir soi-même)</button>
          </div>
          <div class="extras-total-row">
            <span>Total éléments (façade)</span>
            <span>HT ${fmt(totals.ht, "€")} &nbsp;/&nbsp; TTC ${fmt(totals.ttc, "€")}</span>
          </div>
        </div>
      </div>
    `;
  }

  function renderFacadeList(client) {
    facadeListEl.innerHTML = "";
    emptyFacadesEl.hidden = client.facades.length > 0;

    for (const f of client.facades) {
      const c = computeFacade(f);
      const dimsSet = (f.zones && f.zones.length > 0) || (f.largeur > 0 && f.hauteur > 0);
      const card = document.createElement("div");
      card.className = "facade-card";

      const openingsHtml = f.ouvertures.map((o) => {
        const oc = computeOpening(o);
        const typeInfo = OPENING_TYPES[o.type];
        return `
          <div class="opening-item" data-opening-id="${o.id}">
            <div class="opening-info">
              <span class="tag ${typeInfo.tag}">${typeInfo.label}</span>
              ${o.largeur.toFixed(2)} × ${o.hauteur.toFixed(2)} m ${o.qty > 1 ? "× " + o.qty : ""}
              — ${fmt(oc.surface, "m²")}, tabl. ${fmt(oc.tableau, "ml")}${typeInfo.hasAppui ? ", appui " + fmt(oc.appui, "ml") : ""}
            </div>
            <div class="opening-actions">
              <button class="btn btn-ghost btn-small" data-action="edit-opening" data-facade-id="${f.id}" data-opening-id="${o.id}">Modifier</button>
              <button class="btn btn-danger btn-small" data-action="delete-opening" data-facade-id="${f.id}" data-opening-id="${o.id}">✕</button>
            </div>
          </div>
        `;
      }).join("");

      card.innerHTML = `
        <div class="facade-head">
          <div>
            <div class="facade-name">${escapeHtml(f.nom)}</div>
            <div class="facade-dims ${dimsSet ? "" : "facade-dims-missing"}">${dimsSet ? `Surface brute : ${fmt(c.brute, "m²")}` : "⚠ Dimensions non définies — dessinez une zone (rectangle/triangle) dans le croquis"}</div>
            <div class="systeme-badge">${escapeHtml(systemeLabel(f.systeme))}</div>
          </div>
          <div class="facade-actions">
            <button class="btn btn-ghost btn-small" data-action="edit-facade" data-facade-id="${f.id}">Modifier</button>
            <button class="btn btn-danger btn-small" data-action="delete-facade" data-facade-id="${f.id}">Supprimer</button>
          </div>
        </div>

        ${client.facades.length > 1 ? `
        <div class="apply-all-row">
          <button class="btn btn-ghost btn-small" data-action="apply-systeme-all" data-facade-id="${f.id}">Appliquer ce système à toutes les façades</button>
        </div>` : ""}

        <div class="sketch-row">
          ${f.sketch ? `<img class="sketch-thumb" data-action="open-sketch" data-facade-id="${f.id}" src="${f.sketch}" alt="Croquis ${escapeHtml(f.nom)}">` : ""}
          <button class="btn btn-ghost btn-small" data-action="open-sketch" data-facade-id="${f.id}">✏️ ${f.sketch ? "Modifier le croquis" : "Dessiner un croquis"}</button>
        </div>

        ${photoGalleryHtml(f.photos, `data-facade-id="${f.id}"`)}

        ${facadeZonesHtml(f)}

        ${dimsSet ? `
        <div class="facade-metrics">
          <div class="metric-box">
            <span class="m-label">Surface nette</span>
            <span class="m-value">${fmt(c.nette, "m²")}</span>
          </div>
          <div class="metric-box">
            <span class="m-label">Tableaux</span>
            <span class="m-value">${fmt(c.tableau, "ml")}</span>
          </div>
          <div class="metric-box">
            <span class="m-label">Appuis</span>
            <span class="m-value">${fmt(c.appui, "ml")}</span>
          </div>
        </div>` : ""}

        <div class="opening-list">${openingsHtml}</div>

        <div class="add-opening-row">
          <button class="btn btn-primary btn-small" data-action="add-window" data-facade-id="${f.id}">+ Fenêtre</button>
          <button class="btn btn-primary btn-small" data-action="add-door" data-facade-id="${f.id}">+ Porte</button>
          <button class="btn btn-primary btn-small" data-action="add-baie" data-facade-id="${f.id}">+ Baie vitrée</button>
          <button class="btn btn-primary btn-small" data-action="add-baie-simple" data-facade-id="${f.id}">+ Baie simple</button>
        </div>

        ${facadeExtrasHtml(f)}
      `;
      facadeListEl.appendChild(card);
    }
  }

  // ---------- Render : Intérieur (ITI) ----------

  function posteExtrasHtml(poste) {
    const expanded = expandedPosteExtras.has(poste.id);
    const extras = poste.extras || [];
    let extrasHt = 0, extrasTtc = 0;
    const rows = extras.map((ex) => {
      const line = htTtc((ex.qty || 0) * (ex.prix || 0), ex.tva);
      extrasHt += line.ht;
      extrasTtc += line.ttc;
      return `
        <div class="zone-item">
          <div class="zone-info">${escapeHtml(ex.label)} (${escapeHtml(ex.unit)})${ex.taille ? ` — taille ${escapeHtml(ex.taille)}` : ""} — ${ex.qty} × ${fmt(ex.prix, "€")} = HT ${fmt(line.ht, "€")} / TTC ${fmt(line.ttc, "€")}</div>
          <div class="opening-actions">
            <button class="btn btn-ghost btn-small" data-action="edit-poste-extra" data-poste-id="${poste.id}" data-extra-id="${ex.id}">Modifier</button>
            <button class="btn btn-danger btn-small" data-action="delete-poste-extra" data-poste-id="${poste.id}" data-extra-id="${ex.id}">✕</button>
          </div>
        </div>
      `;
    }).join("");

    return `
      <div class="facade-extras">
        <button type="button" class="facade-extras-toggle" data-action="toggle-poste-extras" data-poste-id="${poste.id}">
          Éléments complémentaires${extras.length > 0 ? ` (${extras.length})` : ""} ${expanded ? "▾" : "▸"}
        </button>
        <div class="facade-extras-body" ${expanded ? "" : "hidden"}>
          ${rows || '<p class="empty-msg zones-empty">Aucun élément complémentaire pour ce poste.</p>'}
          <div class="add-opening-row">
            <button class="btn btn-primary btn-small" data-action="add-poste-extra" data-poste-id="${poste.id}">+ Ajouter un élément</button>
          </div>
          <div class="extras-total-row">
            <span>Total éléments (poste)</span>
            <span>HT ${fmt(extrasHt, "€")} &nbsp;/&nbsp; TTC ${fmt(extrasTtc, "€")}</span>
          </div>
        </div>
      </div>
    `;
  }

  function posteSpecsLine(poste) {
    const parts = [];
    if (poste.isolant) {
      const isolantLabel = poste.isolant === "autre" ? (poste.isolantAutre || "Autre") : ISOLANT_ITI_LABELS[poste.isolant];
      parts.push(`Isolant : ${isolantLabel}${poste.epaisseur ? ` (${poste.epaisseur})` : ""}`);
    }
    if (poste.support) parts.push(`Support : ${poste.support}`);
    if (poste.parement) parts.push(`Parement : ${poste.parement}`);
    if (poste.fixation) parts.push(`Fixation : ${poste.fixation}`);
    if (parts.length === 0) return "";
    return `<div class="poste-specs">${parts.map(escapeHtml).join(" &nbsp;·&nbsp; ")}</div>`;
  }

  function posteOuverturesHtml(poste) {
    const ouvertures = poste.ouvertures || [];
    const rows = ouvertures.map((o) => {
      const oc = computePosteOpening(o);
      return `
        <div class="zone-item">
          <div class="zone-info">
            <span class="tag ${o.type === "fenetre" ? "tag-fenetre" : o.type === "porte" ? "tag-porte" : "tag-baie"}">${ITI_OPENING_LABELS[o.type]}</span>
            ${o.largeur.toFixed(2)} × ${o.hauteur.toFixed(2)} m ${o.qty > 1 ? "× " + o.qty : ""} — déduit ${fmt(oc.surface, "m²")}${oc.linteau > 0 ? `, linteau ${fmt(oc.linteau, "ml")}` : ""}
          </div>
          <div class="opening-actions">
            <button class="btn btn-ghost btn-small" data-action="edit-ouverture-iti" data-poste-id="${poste.id}" data-ouverture-id="${o.id}">Modifier</button>
            <button class="btn btn-danger btn-small" data-action="delete-ouverture-iti" data-poste-id="${poste.id}" data-ouverture-id="${o.id}">✕</button>
          </div>
        </div>
      `;
    }).join("");

    return `
      <div class="zone-list">${rows}</div>
      <div class="add-opening-row">
        <button class="btn btn-primary btn-small" data-action="add-ouverture-iti" data-poste-id="${poste.id}">+ Déduire une ouverture</button>
      </div>
    `;
  }

  function posteCardHtml(poste) {
    const c = computePoste(poste);
    const mesures = poste.mesures || [];
    const mesuresHtml = mesures.map((m) => `
      <div class="zone-item">
        <div class="zone-info">${escapeHtml(m.localisation)} — ${m.largeur.toFixed(2)} × ${m.hauteur.toFixed(2)} m ${m.qty > 1 ? "× " + m.qty : ""} = ${fmt(computeMesureArea(m), "m²")}</div>
        <div class="opening-actions">
          <button class="btn btn-ghost btn-small" data-action="edit-mesure" data-poste-id="${poste.id}" data-mesure-id="${m.id}">Modifier</button>
          <button class="btn btn-danger btn-small" data-action="delete-mesure" data-poste-id="${poste.id}" data-mesure-id="${m.id}">✕</button>
        </div>
        ${photoGalleryHtml(m.photos, `data-poste-id="${poste.id}" data-mesure-id="${m.id}"`, true)}
      </div>
    `).join("");

    return `
      <div class="poste-card">
        <div class="facade-head">
          <div>
            <div class="facade-name">${escapeHtml(poste.type)}</div>
            <div class="facade-dims">Surface nette : ${fmt(c.surface, "m²")}${c.ouvSurface > 0 ? ` (brute ${fmt(c.surfaceBrute, "m²")} − ${fmt(c.ouvSurface, "m²")} ouvertures)` : ""}${c.linteauTotal > 0 ? ` — Linteau : ${fmt(c.linteauTotal, "ml")}` : ""}</div>
            <div class="facade-dims">Prix HT/m² ${fmt(poste.prix, "€")}${poste.prixLinteau ? ` · Prix HT/ml linteau ${fmt(poste.prixLinteau, "€")}` : ""} · TVA ${poste.tva}% — HT ${fmt(c.mainHt, "€")} / TTC ${fmt(c.mainTtc, "€")}</div>
            ${posteSpecsLine(poste)}
          </div>
          <div class="facade-actions">
            <button class="btn btn-ghost btn-small" data-action="edit-poste" data-poste-id="${poste.id}">Modifier</button>
            <button class="btn btn-danger btn-small" data-action="delete-poste" data-poste-id="${poste.id}">Supprimer</button>
          </div>
        </div>

        <div class="zone-list">${mesuresHtml || '<p class="empty-msg zones-empty">Aucune cote. Ajoutez-en une.</p>'}</div>

        <div class="add-opening-row">
          <button class="btn btn-primary btn-small" data-action="add-mesure" data-poste-id="${poste.id}">+ Ajouter une cote</button>
        </div>

        ${posteOuverturesHtml(poste)}

        ${posteExtrasHtml(poste)}
      </div>
    `;
  }

  function renderItiZoneList(client) {
    const iti = getClientIti(client);
    itiZoneListEl.innerHTML = "";
    emptyItiZonesEl.hidden = iti.zones.length > 0;

    for (const zone of iti.zones) {
      const zc = computeZoneIti(zone);
      const card = document.createElement("div");
      card.className = "facade-card";
      const postesHtml = (zone.postes || []).map((p) => posteCardHtml(p)).join("");
      card.innerHTML = `
        <div class="facade-head">
          <div>
            <div class="facade-name">${escapeHtml(zone.nom)}</div>
            <div class="facade-dims">Total zone : HT ${fmt(zc.ht, "€")} / TTC ${fmt(zc.ttc, "€")}</div>
          </div>
          <div class="facade-actions">
            <button class="btn btn-ghost btn-small" data-action="edit-zone-iti" data-zone-id="${zone.id}">Modifier</button>
            <button class="btn btn-danger btn-small" data-action="delete-zone-iti" data-zone-id="${zone.id}">Supprimer</button>
          </div>
        </div>

        <div class="poste-list">${postesHtml || '<p class="empty-msg zones-empty">Aucun poste de travaux. Ajoutez-en un.</p>'}</div>

        <div class="add-opening-row">
          <button class="btn btn-primary btn-small" data-action="add-poste" data-zone-id="${zone.id}">+ Ajouter un poste de travaux</button>
        </div>
      `;
      itiZoneListEl.appendChild(card);
    }
  }

  function renderTotals(client) {
    const t = computeClientTotals(client);
    totSurface.textContent = fmt(t.nette, "m²");
    totTableaux.textContent = fmt(t.tableau, "ml");
    totAppuis.textContent = fmt(t.appui, "ml");

    const m2 = getPrixEntry(client, "m2");
    const tab = getPrixEntry(client, "tableau");
    const app = getPrixEntry(client, "appui");

    priceM2Input.value = m2.prix;
    priceTableauInput.value = tab.prix;
    priceAppuiInput.value = app.prix;
    tvaM2Input.value = m2.tva;
    tvaTableauInput.value = tab.tva;
    tvaAppuiInput.value = app.tva;

    const lineM2 = htTtc(t.nette * m2.prix, m2.tva);
    const lineTab = htTtc(t.tableau * tab.prix, tab.tva);
    const lineApp = htTtc(t.appui * app.prix, app.tva);

    subtotalM2HtEl.textContent = fmt(lineM2.ht, "€");
    subtotalM2TtcEl.textContent = fmt(lineM2.ttc, "€");
    subtotalTableauHtEl.textContent = fmt(lineTab.ht, "€");
    subtotalTableauTtcEl.textContent = fmt(lineTab.ttc, "€");
    subtotalAppuiHtEl.textContent = fmt(lineApp.ht, "€");
    subtotalAppuiTtcEl.textContent = fmt(lineApp.ttc, "€");

    const ite = computeIteTotals(client);
    totalIteHtEl.textContent = fmt(ite.ht, "€");
    totalIteTtcEl.textContent = fmt(ite.ttc, "€");

    const extrasTotals = computeClientExtrasTotals(client);
    totalExtrasHtEl.textContent = fmt(extrasTotals.ht, "€");
    totalExtrasTtcEl.textContent = fmt(extrasTotals.ttc, "€");

    const itiWork = computeItiWorkTotals(client);
    totalItiHtEl.textContent = fmt(itiWork.ht, "€");
    totalItiTtcEl.textContent = fmt(itiWork.ttc, "€");

    const itiExtras = computeItiExtrasTotals(client);
    totalItiExtrasHtEl.textContent = fmt(itiExtras.ht, "€");
    totalItiExtrasTtcEl.textContent = fmt(itiExtras.ttc, "€");

    const grand = computeGrandTotals(client);
    grandTotalHtEl.textContent = fmt(grand.ht, "€");
    grandTotalTtcEl.textContent = fmt(grand.ttc, "€");
  }

  function setClientPrix(client, field, value) {
    const entry = getPrixEntry(client, field);
    entry.prix = round2(Math.max(0, value));
    client.updatedAt = Date.now();
    Store.upsertClient(client);
    renderTotals(client);
  }

  function setClientTva(client, field, value) {
    const entry = getPrixEntry(client, field);
    entry.tva = round2(Math.min(100, Math.max(0, value)));
    client.updatedAt = Date.now();
    Store.upsertClient(client);
    renderTotals(client);
  }

  [
    { input: priceM2Input, field: "m2", setter: setClientPrix },
    { input: priceTableauInput, field: "tableau", setter: setClientPrix },
    { input: priceAppuiInput, field: "appui", setter: setClientPrix },
    { input: tvaM2Input, field: "m2", setter: setClientTva },
    { input: tvaTableauInput, field: "tableau", setter: setClientTva },
    { input: tvaAppuiInput, field: "appui", setter: setClientTva },
  ].forEach(({ input, field, setter }) => {
    input.addEventListener("change", () => {
      const client = Store.getClient(currentClientId);
      if (!client) return;
      const val = parseFloat((input.value || "0").replace(",", "."));
      setter(client, field, isNaN(val) ? 0 : val);
    });
  });

  // ---------- Persist des champs client (auto-save) ----------

  function persistClientFields() {
    const client = Store.getClient(currentClientId);
    if (!client) return;
    client.nom = fNom.value;
    client.prenom = fPrenom.value;
    client.adresseChantier = fAdresseChantier.value;
    client.adresseFacturation = fAdresseFacturation.value;
    client.codePostal = fCodePostal.value;
    client.telephone = fTel.value;
    client.email = fEmail.value;
    client.dateVisiteTechnique = fDateVisite.value;
    client.notes = fNotes.value;
    client.m2Habitable = fM2Habitable.value;
    client.anneeConstruction = fAnneeConstruction.value;
    client.systemeChauffage = fSystemeChauffage.value;
    client.personnesCharge = fPersonnesCharge.value;
    client.rfr = fRfr.value;
    client.typeAides = fTypeAides.value;
    client.updatedAt = Date.now();
    Store.upsertClient(client);
    const name = clientFullName(client);
    clientTitle.textContent = name !== "(Sans nom)" ? name : "Nouvelle fiche client";
  }

  [
    fNom, fPrenom, fAdresseChantier, fAdresseFacturation, fCodePostal, fTel, fEmail, fDateVisite, fNotes,
    fM2Habitable, fAnneeConstruction, fSystemeChauffage, fPersonnesCharge, fRfr, fTypeAides,
  ].forEach((el) => {
    el.addEventListener("input", persistClientFields);
    el.addEventListener("change", persistClientFields);
  });

  // ---------- Actions: clients ----------

  document.getElementById("btn-new-client").addEventListener("click", () => {
    const client = {
      id: uid(),
      nom: "",
      prenom: "",
      adresseChantier: "",
      adresseFacturation: "",
      codePostal: "",
      telephone: "",
      email: "",
      dateVisiteTechnique: "",
      notes: "",
      m2Habitable: "",
      anneeConstruction: "",
      systemeChauffage: "",
      personnesCharge: "",
      rfr: "",
      typeAides: "",
      facades: [],
      extras: {},
      prix: defaultClientPrix(),
      iti: defaultClientIti(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    Store.upsertClient(client);
    showClientView(client.id);
    setTimeout(() => fNom.focus(), 50);
  });

  document.getElementById("btn-back-clients").addEventListener("click", showClientsView);

  document.getElementById("btn-delete-client").addEventListener("click", () => {
    const client = Store.getClient(currentClientId);
    if (!client) return;
    if (confirm(`Supprimer définitivement la fiche de "${clientFullName(client)}" ?`)) {
      Store.deleteClient(currentClientId);
      showClientsView();
    }
  });

  clientSearch.addEventListener("input", renderClientList);

  // ---------- Modale générique ----------

  let modalOnSave = null;

  function openModal(title, bodyHtml, onSave) {
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHtml;
    modalOnSave = onSave;
    modalOverlay.hidden = false;
  }

  function closeModal() {
    modalOverlay.hidden = true;
    modalOnSave = null;
  }

  modalCancel.addEventListener("click", closeModal);
  modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });
  modalSave.addEventListener("click", () => {
    if (modalOnSave) {
      const ok = modalOnSave();
      if (ok !== false) closeModal();
    }
  });

  function parseNum(id) {
    const el = document.getElementById(id);
    const v = parseFloat((el.value || "0").replace(",", "."));
    return isNaN(v) ? 0 : v;
  }

  // ---------- Galerie photo (façades et côtes ITI) ----------

  function photoGalleryHtml(photos, dataAttrs, small) {
    const thumbClass = small ? "photo-thumb photo-thumb-sm" : "photo-thumb";
    const addClass = small ? "photo-thumb-add photo-thumb-sm" : "photo-thumb-add";
    const thumbs = (photos || []).map((p) =>
      `<img class="${thumbClass}" data-action="view-photo" ${dataAttrs} data-photo-id="${p.id}" src="${p.dataUrl}" alt="Photo">`
    ).join("");
    return `
      <div class="photo-gallery">
        ${thumbs}
        <button type="button" class="${addClass}" data-action="add-photo" ${dataAttrs}>📷</button>
      </div>
    `;
  }

  let photoTarget = null; // { getPhotos, onSaved }
  let lightboxContext = null; // { getPhotos, photoId, onSaved }

  function openPhotoPicker(target) {
    photoTarget = target;
    photoInputEl.value = "";
    photoInputEl.click();
  }

  photoInputEl.addEventListener("change", async () => {
    if (!photoTarget || !photoInputEl.files.length) return;
    const files = Array.from(photoInputEl.files);
    const photos = photoTarget.getPhotos();
    const onSaved = photoTarget.onSaved;
    for (const file of files) {
      try {
        const dataUrl = await resizeImageFile(file);
        photos.push({ id: uid(), dataUrl });
      } catch (err) {
        console.error("Erreur de traitement de la photo", err);
      }
    }
    onSaved();
  });

  function openLightbox(getPhotos, photoId, onSaved) {
    const photos = getPhotos();
    const photo = photos.find((p) => p.id === photoId);
    if (!photo) return;
    lightboxContext = { getPhotos, photoId, onSaved };
    photoLightboxImgEl.src = photo.dataUrl;
    photoLightboxEl.hidden = false;
  }

  function closeLightbox() {
    photoLightboxEl.hidden = true;
    lightboxContext = null;
  }

  photoLightboxCloseEl.addEventListener("click", closeLightbox);

  photoLightboxDeleteEl.addEventListener("click", () => {
    if (!lightboxContext) return;
    if (!confirm("Supprimer cette photo ?")) return;
    const photos = lightboxContext.getPhotos();
    const idx = photos.findIndex((p) => p.id === lightboxContext.photoId);
    if (idx >= 0) photos.splice(idx, 1);
    const onSaved = lightboxContext.onSaved;
    closeLightbox();
    onSaved();
  });

  // ---------- Actions: façade ----------

  function facadeModal(client, facade) {
    const isNew = !facade;
    const title = isNew ? "Nouvelle façade" : "Modifier la façade";
    const sys = isNew ? defaultSysteme() : (facade.systeme || defaultSysteme());

    const isolantOptions = Object.keys(ISOLANT_LABELS).map((key) =>
      `<option value="${key}" ${sys.isolant === key ? "selected" : ""}>${ISOLANT_LABELS[key]}</option>`
    ).join("");

    const body = `
      <label>Nom / repère de la façade
        <input type="text" id="m-facade-nom" placeholder="Ex: Façade Nord" value="${isNew ? "" : escapeHtml(facade.nom)}">
      </label>
      <p class="modal-hint">📐 Les dimensions de la façade se définissent dans le croquis (outil ▭ Rectangle), pas ici.</p>
      <div class="field-row">
        <label>Isolant
          <select id="m-facade-isolant">${isolantOptions}</select>
        </label>
        <label>Finition
          <select id="m-facade-finition"></select>
        </label>
      </div>
      <label id="m-facade-bardage-wrap" hidden>Type de bardage
        <input type="text" id="m-facade-bardage" placeholder="Ex: Clins bois composite, Trespa gris anthracite..." value="${escapeHtml(sys.bardageType || "")}">
      </label>
    `;

    openModal(title, body, () => {
      const nom = document.getElementById("m-facade-nom").value.trim() || "Façade";

      const isolant = document.getElementById("m-facade-isolant").value;
      const finition = document.getElementById("m-facade-finition").value;
      const bardageType = finition === "bardage" ? document.getElementById("m-facade-bardage").value.trim() : "";
      const systeme = { isolant, finition, bardageType };

      if (isNew) {
        client.facades.push({ id: uid(), nom, largeur: 0, hauteur: 0, ouvertures: [], systeme, extras: {}, customExtras: [], photos: [] });
      } else {
        facade.nom = nom;
        facade.systeme = systeme;
      }
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    });

    const isolantSelect = document.getElementById("m-facade-isolant");
    const finitionSelect = document.getElementById("m-facade-finition");
    const bardageWrap = document.getElementById("m-facade-bardage-wrap");

    function refreshFinitionOptions(selectedFinition) {
      const options = FINITIONS_BY_ISOLANT[isolantSelect.value];
      finitionSelect.innerHTML = options.map((key) =>
        `<option value="${key}" ${key === selectedFinition ? "selected" : ""}>${FINITION_LABELS[key]}</option>`
      ).join("");
      if (!options.includes(selectedFinition)) finitionSelect.value = options[0];
      bardageWrap.hidden = finitionSelect.value !== "bardage";
    }

    refreshFinitionOptions(sys.finition);
    isolantSelect.addEventListener("change", () => refreshFinitionOptions(sys.finition));
    finitionSelect.addEventListener("change", () => { bardageWrap.hidden = finitionSelect.value !== "bardage"; });

    setTimeout(() => document.getElementById("m-facade-nom").focus(), 50);
  }

  document.getElementById("btn-add-facade").addEventListener("click", () => {
    const client = Store.getClient(currentClientId);
    facadeModal(client, null);
  });

  // ---------- Actions: zone de façade (côte saisie à la main, en plus du croquis) ----------

  function zoneManualModal(client, facade, zone) {
    const isNew = !zone;
    const title = isNew ? "Nouvelle côte (saisie à la main)" : "Modifier la côte";
    const type = isNew ? "rectangle" : zone.type;
    const kind = isNew ? "ajout" : zone.kind;

    const typeButtonsHtml = `
      <button type="button" data-type="rectangle" class="${type === "rectangle" ? "active" : ""}">▭ Rectangle</button>
      <button type="button" data-type="triangle" class="${type === "triangle" ? "active" : ""}">🔺 Triangle (pignon)</button>
    `;
    const kindButtonsHtml = `
      <button type="button" data-kind="ajout" class="${kind === "ajout" ? "active" : ""}">Ajout</button>
      <button type="button" data-kind="deduit" class="${kind === "deduit" ? "active" : ""}">Déduit</button>
      <button type="button" data-kind="autre" class="${kind === "autre" ? "active" : ""}">Autre (prix à part)</button>
    `;

    const body = `
      <p class="modal-hint">Forme de la zone :</p>
      <div class="type-toggle" id="m-zone-type-toggle">${typeButtonsHtml}</div>
      <p class="modal-hint">Cette zone est à :</p>
      <div class="type-toggle" id="m-zone-kind-toggle">${kindButtonsHtml}</div>
      <div class="field-row">
        <label>Largeur (m)
          <input type="number" id="m-zone-largeur" step="0.01" min="0" inputmode="decimal" value="${isNew ? "" : zone.width}">
        </label>
        <label>Hauteur (m)
          <input type="number" id="m-zone-hauteur" step="0.01" min="0" inputmode="decimal" value="${isNew ? "" : zone.height}">
        </label>
      </div>
      <label id="m-zone-label-wrap" hidden>Libellé
        <input type="text" id="m-zone-label" placeholder="Ex: Peinture, RPE simple..." value="${isNew ? "" : escapeHtml(zone.label || "")}">
      </label>
      <div class="field-row" id="m-zone-prix-wrap" hidden>
        <label>Prix HT/m² (€)
          <input type="number" id="m-zone-prix" step="0.01" min="0" inputmode="decimal" value="${isNew ? "0" : zone.prix}">
        </label>
        <label>TVA (%)
          <input type="number" id="m-zone-tva" step="0.1" min="0" max="100" inputmode="decimal" value="${isNew ? DEFAULT_TVA : zone.tva}">
        </label>
      </div>
    `;

    let currentType = type;
    let currentKind = kind;

    openModal(title, body, () => {
      const width = parseNum("m-zone-largeur");
      const height = parseNum("m-zone-hauteur");
      if (width <= 0 || height <= 0) { alert("Merci de renseigner largeur et hauteur."); return false; }
      const label = currentKind === "autre" ? document.getElementById("m-zone-label").value.trim() : "";
      if (currentKind === "autre" && !label) { alert("Merci de préciser un libellé pour cette zone."); return false; }
      const prix = currentKind === "autre" ? round2(Math.max(0, parseNum("m-zone-prix"))) : 0;
      const tva = currentKind === "autre" ? round2(Math.min(100, Math.max(0, parseNum("m-zone-tva")))) : DEFAULT_TVA;

      if (isNew) {
        if (!facade.zones) facade.zones = [];
        facade.zones.push({ id: uid(), type: currentType, width, height, kind: currentKind, label, prix, tva });
      } else {
        zone.type = currentType;
        zone.width = width;
        zone.height = height;
        zone.kind = currentKind;
        zone.label = label;
        zone.prix = prix;
        zone.tva = tva;
      }
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    });

    const typeBtns = Array.from(document.getElementById("m-zone-type-toggle").querySelectorAll("button"));
    typeBtns.forEach((b) => {
      b.addEventListener("click", () => {
        currentType = b.dataset.type;
        typeBtns.forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      });
    });

    const kindBtns = Array.from(document.getElementById("m-zone-kind-toggle").querySelectorAll("button"));
    const labelWrap = document.getElementById("m-zone-label-wrap");
    const prixWrap = document.getElementById("m-zone-prix-wrap");
    function refreshKindUI() {
      const isAutre = currentKind === "autre";
      labelWrap.hidden = !isAutre;
      prixWrap.hidden = !isAutre;
    }
    kindBtns.forEach((b) => {
      b.addEventListener("click", () => {
        currentKind = b.dataset.kind;
        kindBtns.forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        refreshKindUI();
      });
    });
    refreshKindUI();

    setTimeout(() => document.getElementById("m-zone-largeur").focus(), 50);
  }

  // ---------- Actions: élément complémentaire "autre" (façade ITE, saisi librement) ----------

  function facadeExtraModal(client, facade, extra) {
    const isNew = !extra;
    const title = isNew ? "Nouvel élément \"autre\"" : "Modifier l'élément";

    const body = `
      <label>Libellé
        <input type="text" id="m-fextra-label" placeholder="Ex: Habillage volet roulant..." value="${isNew ? "" : escapeHtml(extra.label)}">
      </label>
      <div class="field-row">
        <label>Quantité
          <input type="number" id="m-fextra-qty" step="0.01" min="0" inputmode="decimal" value="${isNew ? "1" : extra.qty}">
        </label>
        <label>Unité
          <input type="text" id="m-fextra-unit" placeholder="m², ml, unité..." value="${isNew ? "unité" : escapeHtml(extra.unit)}">
        </label>
      </div>
      <div class="field-row">
        <label>Prix HT (€)
          <input type="number" id="m-fextra-prix" step="0.01" min="0" inputmode="decimal" value="${isNew ? "0" : extra.prix}">
        </label>
        <label>TVA (%)
          <input type="number" id="m-fextra-tva" step="0.1" min="0" max="100" inputmode="decimal" value="${isNew ? DEFAULT_TVA : extra.tva}">
        </label>
      </div>
    `;

    openModal(title, body, () => {
      const label = document.getElementById("m-fextra-label").value.trim();
      if (!label) { alert("Merci de préciser un libellé."); return false; }
      const qty = round2(Math.max(0, parseNum("m-fextra-qty")));
      const unit = document.getElementById("m-fextra-unit").value.trim() || "unité";
      const prix = round2(Math.max(0, parseNum("m-fextra-prix")));
      const tva = round2(Math.min(100, Math.max(0, parseNum("m-fextra-tva"))));

      const customExtras = getFacadeCustomExtras(facade);
      if (isNew) {
        customExtras.push({ id: uid(), label, qty, unit, prix, tva });
      } else {
        extra.label = label;
        extra.qty = qty;
        extra.unit = unit;
        extra.prix = prix;
        extra.tva = tva;
      }
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    });

    setTimeout(() => document.getElementById("m-fextra-label").focus(), 50);
  }

  // ---------- Actions: ouverture (fenêtre / porte) ----------

  function openingModal(client, facade, opening, defaultType) {
    const isNew = !opening;
    const type = isNew ? defaultType : opening.type;
    const title = isNew ? `Nouvelle ${OPENING_TYPES[type].label.toLowerCase()}` : "Modifier l'ouverture";

    const typeButtonsHtml = Object.keys(OPENING_TYPES).map((key) =>
      `<button type="button" data-type="${key}" class="${type === key ? "active" : ""}">${OPENING_TYPES[key].label}</button>`
    ).join("");

    const body = `
      <div class="type-toggle type-toggle-4">${typeButtonsHtml}</div>
      <div class="field-row">
        <label>Largeur (m)
          <input type="number" id="m-op-largeur" step="0.01" min="0" inputmode="decimal" value="${isNew ? "" : opening.largeur}">
        </label>
        <label>Hauteur (m)
          <input type="number" id="m-op-hauteur" step="0.01" min="0" inputmode="decimal" value="${isNew ? "" : opening.hauteur}">
        </label>
        <label>Quantité
          <input type="number" id="m-op-qty" step="1" min="1" value="${isNew ? "1" : opening.qty}">
        </label>
      </div>
    `;
    let currentType = type;
    openModal(title, body, () => {
      const largeur = parseNum("m-op-largeur");
      const hauteur = parseNum("m-op-hauteur");
      const qty = Math.max(1, Math.round(parseNum("m-op-qty") || 1));
      if (largeur <= 0 || hauteur <= 0) { alert("Merci de renseigner largeur et hauteur."); return false; }

      if (isNew) {
        facade.ouvertures.push({ id: uid(), type: currentType, largeur, hauteur, qty });
      } else {
        opening.type = currentType;
        opening.largeur = largeur;
        opening.hauteur = hauteur;
        opening.qty = qty;
      }
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    });

    const typeBtns = Array.from(document.querySelectorAll(".type-toggle-4 button"));
    typeBtns.forEach((b) => {
      b.addEventListener("click", () => {
        currentType = b.dataset.type;
        typeBtns.forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      });
    });

    setTimeout(() => document.getElementById("m-op-largeur").focus(), 50);
  }

  // ---------- Délégation d'évènements sur la liste des façades ----------

  facadeListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const client = Store.getClient(currentClientId);
    if (!client) return;

    const action = btn.dataset.action;
    const facadeId = btn.dataset.facadeId;
    const facade = client.facades.find((f) => f.id === facadeId);

    if (action === "edit-facade") {
      facadeModal(client, facade);
    } else if (action === "delete-facade") {
      if (confirm(`Supprimer la façade "${facade.nom}" et toutes ses ouvertures ?`)) {
        client.facades = client.facades.filter((f) => f.id !== facadeId);
        client.updatedAt = Date.now();
        Store.upsertClient(client);
        renderClientView();
      }
    } else if (action === "add-window") {
      openingModal(client, facade, null, "fenetre");
    } else if (action === "add-door") {
      openingModal(client, facade, null, "porte");
    } else if (action === "add-baie") {
      openingModal(client, facade, null, "baie_vitree");
    } else if (action === "add-baie-simple") {
      openingModal(client, facade, null, "baie_vitree_simple");
    } else if (action === "edit-opening") {
      const opening = facade.ouvertures.find((o) => o.id === btn.dataset.openingId);
      openingModal(client, facade, opening, null);
    } else if (action === "delete-opening") {
      facade.ouvertures = facade.ouvertures.filter((o) => o.id !== btn.dataset.openingId);
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    } else if (action === "apply-systeme-all") {
      const sys = facade.systeme || defaultSysteme();
      for (const f of client.facades) f.systeme = { ...sys };
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    } else if (action === "open-sketch") {
      openSketchEditor(client, facade);
    } else if (action === "add-photo") {
      openPhotoPicker({
        getPhotos: () => { if (!facade.photos) facade.photos = []; return facade.photos; },
        onSaved: () => { client.updatedAt = Date.now(); Store.upsertClient(client); renderClientView(); },
      });
    } else if (action === "view-photo") {
      openLightbox(
        () => { if (!facade.photos) facade.photos = []; return facade.photos; },
        btn.dataset.photoId,
        () => { client.updatedAt = Date.now(); Store.upsertClient(client); renderClientView(); }
      );
    } else if (action === "toggle-extras") {
      if (expandedFacadeExtras.has(facadeId)) expandedFacadeExtras.delete(facadeId);
      else expandedFacadeExtras.add(facadeId);
      renderFacadeList(client);
    } else if (action === "delete-zone") {
      facade.zones = (facade.zones || []).filter((z) => z.id !== btn.dataset.zoneId);
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    } else if (action === "add-zone-manual") {
      zoneManualModal(client, facade, null);
    } else if (action === "edit-zone") {
      const zone = (facade.zones || []).find((z) => z.id === btn.dataset.zoneId);
      if (zone) zoneManualModal(client, facade, zone);
    } else if (action === "add-facade-extra") {
      facadeExtraModal(client, facade, null);
    } else if (action === "edit-facade-extra") {
      const extra = getFacadeCustomExtras(facade).find((ex) => ex.id === btn.dataset.extraId);
      if (extra) facadeExtraModal(client, facade, extra);
    } else if (action === "delete-facade-extra") {
      facade.customExtras = getFacadeCustomExtras(facade).filter((ex) => ex.id !== btn.dataset.extraId);
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    }
  });

  facadeListEl.addEventListener("change", (e) => {
    const priceInput = e.target.closest(".zone-price-input");
    const tvaInput = e.target.closest(".zone-tva-input");
    if (!priceInput && !tvaInput) return;

    const client = Store.getClient(currentClientId);
    if (!client) return;
    const input = priceInput || tvaInput;
    const facade = client.facades.find((f) => f.id === input.dataset.facadeId);
    if (!facade) return;
    const zone = (facade.zones || []).find((z) => z.id === input.dataset.zoneId);
    if (!zone) return;

    const val = parseFloat((input.value || "0").replace(",", "."));
    if (priceInput) zone.prix = round2(Math.max(0, isNaN(val) ? 0 : val));
    else zone.tva = round2(Math.min(100, Math.max(0, isNaN(val) ? 0 : val)));

    client.updatedAt = Date.now();
    Store.upsertClient(client);
    renderFacadeList(client);
    renderTotals(client);
  });

  // ---------- Éléments complémentaires (par façade) : évènements ----------

  function setExtraQty(client, facade, key, qty) {
    const catalogItem = EXTRAS_CATALOG.find((it) => it.key === key);
    const step = catalogItem.unit === "unité" ? 1 : 0.01;
    const rounded = Math.round(Math.max(0, qty) / step) * step;
    const entry = getExtraEntry(facade, key);
    entry.qty = round2(rounded);
    client.updatedAt = Date.now();
    Store.upsertClient(client);
    renderFacadeList(client);
    renderTotals(client);
  }

  function setExtraPrix(client, facade, key, prix) {
    const entry = getExtraEntry(facade, key);
    entry.prix = round2(Math.max(0, prix));
    client.updatedAt = Date.now();
    Store.upsertClient(client);
    renderFacadeList(client);
    renderTotals(client);
  }

  function setExtraTva(client, facade, key, tva) {
    const entry = getExtraEntry(facade, key);
    entry.tva = round2(Math.min(100, Math.max(0, tva)));
    client.updatedAt = Date.now();
    Store.upsertClient(client);
    renderFacadeList(client);
    renderTotals(client);
  }

  facadeListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action='extra-inc'], button[data-action='extra-dec']");
    if (!btn) return;
    const client = Store.getClient(currentClientId);
    if (!client) return;
    const facade = client.facades.find((f) => f.id === btn.dataset.facadeId);
    if (!facade) return;
    const key = btn.dataset.key;
    const current = getExtraEntry(facade, key).qty || 0;
    const catalogItem = EXTRAS_CATALOG.find((it) => it.key === key);
    const step = catalogItem.unit === "unité" ? 1 : 0.5;

    if (btn.dataset.action === "extra-inc") {
      setExtraQty(client, facade, key, current + step);
    } else if (btn.dataset.action === "extra-dec") {
      setExtraQty(client, facade, key, current - step);
    }
  });

  facadeListEl.addEventListener("change", (e) => {
    const client = Store.getClient(currentClientId);
    if (!client) return;

    const qtyInput = e.target.closest(".extra-qty-input");
    if (qtyInput) {
      const facade = client.facades.find((f) => f.id === qtyInput.dataset.facadeId);
      if (!facade) return;
      const val = parseFloat((qtyInput.value || "0").replace(",", "."));
      setExtraQty(client, facade, qtyInput.dataset.key, isNaN(val) ? 0 : val);
      return;
    }
    const priceInput = e.target.closest(".extra-price-input");
    if (priceInput) {
      const facade = client.facades.find((f) => f.id === priceInput.dataset.facadeId);
      if (!facade) return;
      const val = parseFloat((priceInput.value || "0").replace(",", "."));
      setExtraPrix(client, facade, priceInput.dataset.key, isNaN(val) ? 0 : val);
      return;
    }
    const tvaInput = e.target.closest(".extra-tva-input");
    if (tvaInput) {
      const facade = client.facades.find((f) => f.id === tvaInput.dataset.facadeId);
      if (!facade) return;
      const val = parseFloat((tvaInput.value || "0").replace(",", "."));
      setExtraTva(client, facade, tvaInput.dataset.key, isNaN(val) ? 0 : val);
    }
  });

  // ---------- Intérieur (ITI) : recherche, modals, évènements ----------

  function findZoneIti(client, zoneId) {
    return getClientIti(client).zones.find((z) => z.id === zoneId);
  }

  function findPosteIti(client, posteId) {
    for (const zone of getClientIti(client).zones) {
      const poste = (zone.postes || []).find((p) => p.id === posteId);
      if (poste) return { zone, poste };
    }
    return null;
  }

  function zoneItiModal(client, zone) {
    const isNew = !zone;
    const title = isNew ? "Nouvelle zone" : "Modifier la zone";
    const body = `
      <label>Nom de la zone
        <input type="text" id="m-zone-nom" placeholder="Ex: RDC, R+1, Combles..." value="${isNew ? "" : escapeHtml(zone.nom)}">
      </label>
    `;
    openModal(title, body, () => {
      const nom = document.getElementById("m-zone-nom").value.trim() || "Zone";
      if (isNew) {
        getClientIti(client).zones.push({ id: uid(), nom, postes: [] });
      } else {
        zone.nom = nom;
      }
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    });
    setTimeout(() => document.getElementById("m-zone-nom").focus(), 50);
  }

  document.getElementById("btn-add-zone-iti").addEventListener("click", () => {
    const client = Store.getClient(currentClientId);
    zoneItiModal(client, null);
  });

  function posteModal(client, zone, poste) {
    const isNew = !poste;
    const title = isNew ? "Nouveau poste de travaux" : "Modifier le poste";
    const isolantVal = isNew ? "" : (poste.isolant || "");

    const isolantOptionsHtml = `<option value="">— Non précisé —</option>` + Object.keys(ISOLANT_ITI_LABELS).map((key) =>
      `<option value="${key}" ${isolantVal === key ? "selected" : ""}>${ISOLANT_ITI_LABELS[key]}</option>`
    ).join("");

    const body = `
      <label>Type de travaux
        <input type="text" id="m-poste-type" list="iti-poste-suggestions" placeholder="Ex: Isolation des rampants" value="${isNew ? "" : escapeHtml(poste.type)}">
      </label>
      <div class="field-row">
        <label>Prix HT/m² (€)
          <input type="number" id="m-poste-prix" step="0.01" min="0" inputmode="decimal" value="${isNew ? "0" : poste.prix}">
        </label>
        <label>Prix HT/ml linteau (€)
          <input type="number" id="m-poste-prix-linteau" step="0.01" min="0" inputmode="decimal" value="${isNew ? "0" : (poste.prixLinteau || 0)}">
        </label>
        <label>TVA (%)
          <input type="number" id="m-poste-tva" step="0.1" min="0" max="100" inputmode="decimal" value="${isNew ? DEFAULT_TVA : poste.tva}">
        </label>
      </div>
      <div class="field-row">
        <label>Isolant
          <select id="m-poste-isolant">${isolantOptionsHtml}</select>
        </label>
        <label>Épaisseur
          <input type="text" id="m-poste-epaisseur" placeholder="Ex: 100mm, 2×100mm..." value="${isNew ? "" : escapeHtml(poste.epaisseur || "")}">
        </label>
      </div>
      <label id="m-poste-isolant-autre-wrap" hidden>Préciser l'isolant
        <input type="text" id="m-poste-isolant-autre" placeholder="Nom de l'isolant" value="${isNew ? "" : escapeHtml(poste.isolantAutre || "")}">
      </label>
      <div class="field-row">
        <label>Support
          <input type="text" id="m-poste-support" placeholder="Ex: Ossature bois, mur béton..." value="${isNew ? "" : escapeHtml(poste.support || "")}">
        </label>
        <label>Parement / finition
          <input type="text" id="m-poste-parement" placeholder="Ex: Placo BA13, lambris..." value="${isNew ? "" : escapeHtml(poste.parement || "")}">
        </label>
      </div>
      <label>Système de fixation
        <input type="text" id="m-poste-fixation" placeholder="Ex: Suspentes, rails, chevilles..." value="${isNew ? "" : escapeHtml(poste.fixation || "")}">
      </label>
    `;
    openModal(title, body, () => {
      const type = document.getElementById("m-poste-type").value.trim();
      if (!type) { alert("Merci de préciser le type de travaux."); return false; }
      const prix = round2(Math.max(0, parseNum("m-poste-prix")));
      const prixLinteau = round2(Math.max(0, parseNum("m-poste-prix-linteau")));
      const tva = round2(Math.min(100, Math.max(0, parseNum("m-poste-tva"))));
      const isolant = document.getElementById("m-poste-isolant").value;
      const isolantAutre = isolant === "autre" ? document.getElementById("m-poste-isolant-autre").value.trim() : "";
      const epaisseur = document.getElementById("m-poste-epaisseur").value.trim();
      const support = document.getElementById("m-poste-support").value.trim();
      const parement = document.getElementById("m-poste-parement").value.trim();
      const fixation = document.getElementById("m-poste-fixation").value.trim();
      const specs = { isolant, isolantAutre, epaisseur, support, parement, fixation };

      if (isNew) {
        if (!zone.postes) zone.postes = [];
        zone.postes.push({ id: uid(), type, prix, prixLinteau, tva, mesures: [], ouvertures: [], extras: [], ...specs });
      } else {
        poste.type = type;
        poste.prix = prix;
        poste.prixLinteau = prixLinteau;
        poste.tva = tva;
        Object.assign(poste, specs);
      }
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    });

    const isolantSelectEl = document.getElementById("m-poste-isolant");
    const isolantAutreWrap = document.getElementById("m-poste-isolant-autre-wrap");
    isolantAutreWrap.hidden = isolantSelectEl.value !== "autre";
    isolantSelectEl.addEventListener("change", () => {
      isolantAutreWrap.hidden = isolantSelectEl.value !== "autre";
    });
    setTimeout(() => document.getElementById("m-poste-type").focus(), 50);
  }

  function mesureModal(client, poste, mesure) {
    const isNew = !mesure;
    const title = isNew ? "Nouvelle cote" : "Modifier la cote";
    const body = `
      <label>Localisation
        <input type="text" id="m-mesure-loc" placeholder="Ex: Chambre 1, Salon, Mur nord..." value="${isNew ? "" : escapeHtml(mesure.localisation)}">
      </label>
      <div class="field-row">
        <label>Largeur (m)
          <input type="number" id="m-mesure-largeur" step="0.01" min="0" inputmode="decimal" value="${isNew ? "" : mesure.largeur}">
        </label>
        <label>Hauteur (m)
          <input type="number" id="m-mesure-hauteur" step="0.01" min="0" inputmode="decimal" value="${isNew ? "" : mesure.hauteur}">
        </label>
        <label>Quantité
          <input type="number" id="m-mesure-qty" step="1" min="1" value="${isNew ? "1" : mesure.qty}">
        </label>
      </div>
    `;
    openModal(title, body, () => {
      const localisation = document.getElementById("m-mesure-loc").value.trim() || "Sans nom";
      const largeur = parseNum("m-mesure-largeur");
      const hauteur = parseNum("m-mesure-hauteur");
      const qty = Math.max(1, Math.round(parseNum("m-mesure-qty") || 1));
      if (largeur <= 0 || hauteur <= 0) { alert("Merci de renseigner largeur et hauteur."); return false; }

      if (isNew) {
        if (!poste.mesures) poste.mesures = [];
        poste.mesures.push({ id: uid(), localisation, largeur, hauteur, qty, photos: [] });
      } else {
        mesure.localisation = localisation;
        mesure.largeur = largeur;
        mesure.hauteur = hauteur;
        mesure.qty = qty;
      }
      const client2 = Store.getClient(currentClientId);
      client2.updatedAt = Date.now();
      Store.upsertClient(client2);
      renderClientView();
    });
    setTimeout(() => document.getElementById("m-mesure-loc").focus(), 50);
  }

  function ouvertureItiModal(client, poste, ouverture) {
    const isNew = !ouverture;
    const title = isNew ? "Nouvelle ouverture à déduire" : "Modifier l'ouverture";
    const typeVal = isNew ? "fenetre" : ouverture.type;

    const typeButtonsHtml = Object.keys(ITI_OPENING_LABELS).map((key) =>
      `<button type="button" data-type="${key}" class="${typeVal === key ? "active" : ""}">${ITI_OPENING_LABELS[key]}</button>`
    ).join("");

    const body = `
      <div class="type-toggle type-toggle-iti">${typeButtonsHtml}</div>
      <p class="modal-hint">Fenêtre = linteau sur 4 côtés. Porte = 3 côtés (pas de sol). Velux = surface déduite seulement, pas de linteau (utilisez l'élément "Habillage de velux" pour le forfait).</p>
      <div class="field-row">
        <label>Largeur (m)
          <input type="number" id="m-ouv-largeur" step="0.01" min="0" inputmode="decimal" value="${isNew ? "" : ouverture.largeur}">
        </label>
        <label>Hauteur (m)
          <input type="number" id="m-ouv-hauteur" step="0.01" min="0" inputmode="decimal" value="${isNew ? "" : ouverture.hauteur}">
        </label>
        <label>Quantité
          <input type="number" id="m-ouv-qty" step="1" min="1" value="${isNew ? "1" : ouverture.qty}">
        </label>
      </div>
    `;
    let currentType = typeVal;
    openModal(title, body, () => {
      const largeur = parseNum("m-ouv-largeur");
      const hauteur = parseNum("m-ouv-hauteur");
      const qty = Math.max(1, Math.round(parseNum("m-ouv-qty") || 1));
      if (largeur <= 0 || hauteur <= 0) { alert("Merci de renseigner largeur et hauteur."); return false; }

      if (isNew) {
        if (!poste.ouvertures) poste.ouvertures = [];
        poste.ouvertures.push({ id: uid(), type: currentType, largeur, hauteur, qty });
      } else {
        ouverture.type = currentType;
        ouverture.largeur = largeur;
        ouverture.hauteur = hauteur;
        ouverture.qty = qty;
      }
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    });

    const typeBtns = Array.from(document.querySelectorAll(".type-toggle-iti button"));
    typeBtns.forEach((b) => {
      b.addEventListener("click", () => {
        currentType = b.dataset.type;
        typeBtns.forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      });
    });

    setTimeout(() => document.getElementById("m-ouv-largeur").focus(), 50);
  }

  function posteExtraModal(client, poste, extra) {
    const isNew = !extra;
    const title = isNew ? "Nouvel élément complémentaire" : "Modifier l'élément";
    const currentKey = isNew ? "" : (extra.catalogKey || "");

    const catalogOptionsHtml = `<option value="">— Personnalisé —</option>` + ITI_EXTRAS_CATALOG.map((item) =>
      `<option value="${item.key}" ${currentKey === item.key ? "selected" : ""}>${item.label} (${item.unit})</option>`
    ).join("");

    const body = `
      <label>Élément
        <select id="m-pextra-catalog">${catalogOptionsHtml}</select>
      </label>
      <label>Libellé
        <input type="text" id="m-pextra-label" placeholder="Ex: Peinture, Bande à joint..." value="${isNew ? "" : escapeHtml(extra.label)}">
      </label>
      <label id="m-pextra-taille-wrap" hidden>Taille
        <input type="text" id="m-pextra-taille" placeholder="Ex: 60x60, 80x204..." value="${isNew ? "" : escapeHtml(extra.taille || "")}">
      </label>
      <div class="field-row">
        <label>Quantité
          <input type="number" id="m-pextra-qty" step="0.01" min="0" inputmode="decimal" value="${isNew ? "1" : extra.qty}">
        </label>
        <label>Unité
          <input type="text" id="m-pextra-unit" placeholder="m², ml, unité..." value="${isNew ? "m²" : escapeHtml(extra.unit)}">
        </label>
      </div>
      <div class="field-row">
        <label>Prix HT (€)
          <input type="number" id="m-pextra-prix" step="0.01" min="0" inputmode="decimal" value="${isNew ? "0" : extra.prix}">
        </label>
        <label>TVA (%)
          <input type="number" id="m-pextra-tva" step="0.1" min="0" max="100" inputmode="decimal" value="${isNew ? DEFAULT_TVA : extra.tva}">
        </label>
      </div>
    `;
    openModal(title, body, () => {
      const label = document.getElementById("m-pextra-label").value.trim();
      if (!label) { alert("Merci de préciser un libellé."); return false; }
      const catalogKey = document.getElementById("m-pextra-catalog").value;
      const taille = document.getElementById("m-pextra-taille").value.trim();
      const qty = round2(Math.max(0, parseNum("m-pextra-qty")));
      const unit = document.getElementById("m-pextra-unit").value.trim() || "unité";
      const prix = round2(Math.max(0, parseNum("m-pextra-prix")));
      const tva = round2(Math.min(100, Math.max(0, parseNum("m-pextra-tva"))));

      if (isNew) {
        if (!poste.extras) poste.extras = [];
        poste.extras.push({ id: uid(), label, qty, unit, prix, tva, catalogKey, taille });
      } else {
        extra.label = label;
        extra.qty = qty;
        extra.unit = unit;
        extra.prix = prix;
        extra.tva = tva;
        extra.catalogKey = catalogKey;
        extra.taille = taille;
      }
      client.updatedAt = Date.now();
      Store.upsertClient(client);
      renderClientView();
    });

    const catalogSelect = document.getElementById("m-pextra-catalog");
    const labelInput = document.getElementById("m-pextra-label");
    const unitInput = document.getElementById("m-pextra-unit");
    const tailleWrap = document.getElementById("m-pextra-taille-wrap");

    const initialItem = ITI_EXTRAS_CATALOG.find((it) => it.key === currentKey);
    tailleWrap.hidden = !(initialItem && initialItem.hasTaille);

    catalogSelect.addEventListener("change", () => {
      const item = ITI_EXTRAS_CATALOG.find((it) => it.key === catalogSelect.value);
      if (item) {
        labelInput.value = item.label;
        unitInput.value = item.unit;
        tailleWrap.hidden = !item.hasTaille;
      } else {
        tailleWrap.hidden = true;
      }
    });

    setTimeout(() => document.getElementById("m-pextra-label").focus(), 50);
  }

  itiZoneListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const client = Store.getClient(currentClientId);
    if (!client) return;
    const action = btn.dataset.action;

    if (action === "edit-zone-iti") {
      zoneItiModal(client, findZoneIti(client, btn.dataset.zoneId));
    } else if (action === "delete-zone-iti") {
      const zone = findZoneIti(client, btn.dataset.zoneId);
      if (confirm(`Supprimer la zone "${zone.nom}" et tous ses postes de travaux ?`)) {
        const iti = getClientIti(client);
        iti.zones = iti.zones.filter((z) => z.id !== btn.dataset.zoneId);
        client.updatedAt = Date.now();
        Store.upsertClient(client);
        renderClientView();
      }
    } else if (action === "add-poste") {
      posteModal(client, findZoneIti(client, btn.dataset.zoneId), null);
    } else if (action === "edit-poste") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) posteModal(client, found.zone, found.poste);
    } else if (action === "delete-poste") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found && confirm(`Supprimer le poste "${found.poste.type}" ?`)) {
        found.zone.postes = found.zone.postes.filter((p) => p.id !== btn.dataset.posteId);
        client.updatedAt = Date.now();
        Store.upsertClient(client);
        renderClientView();
      }
    } else if (action === "add-mesure") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) mesureModal(client, found.poste, null);
    } else if (action === "edit-mesure") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) {
        const mesure = (found.poste.mesures || []).find((m) => m.id === btn.dataset.mesureId);
        mesureModal(client, found.poste, mesure);
      }
    } else if (action === "delete-mesure") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) {
        found.poste.mesures = (found.poste.mesures || []).filter((m) => m.id !== btn.dataset.mesureId);
        client.updatedAt = Date.now();
        Store.upsertClient(client);
        renderClientView();
      }
    } else if (action === "add-ouverture-iti") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) ouvertureItiModal(client, found.poste, null);
    } else if (action === "edit-ouverture-iti") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) {
        const ouverture = (found.poste.ouvertures || []).find((o) => o.id === btn.dataset.ouvertureId);
        ouvertureItiModal(client, found.poste, ouverture);
      }
    } else if (action === "delete-ouverture-iti") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) {
        found.poste.ouvertures = (found.poste.ouvertures || []).filter((o) => o.id !== btn.dataset.ouvertureId);
        client.updatedAt = Date.now();
        Store.upsertClient(client);
        renderClientView();
      }
    } else if (action === "add-photo") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) {
        const mesure = (found.poste.mesures || []).find((m) => m.id === btn.dataset.mesureId);
        if (mesure) {
          openPhotoPicker({
            getPhotos: () => { if (!mesure.photos) mesure.photos = []; return mesure.photos; },
            onSaved: () => { client.updatedAt = Date.now(); Store.upsertClient(client); renderClientView(); },
          });
        }
      }
    } else if (action === "view-photo") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) {
        const mesure = (found.poste.mesures || []).find((m) => m.id === btn.dataset.mesureId);
        if (mesure) {
          openLightbox(
            () => { if (!mesure.photos) mesure.photos = []; return mesure.photos; },
            btn.dataset.photoId,
            () => { client.updatedAt = Date.now(); Store.upsertClient(client); renderClientView(); }
          );
        }
      }
    } else if (action === "toggle-poste-extras") {
      const posteId = btn.dataset.posteId;
      if (expandedPosteExtras.has(posteId)) expandedPosteExtras.delete(posteId);
      else expandedPosteExtras.add(posteId);
      renderItiZoneList(client);
    } else if (action === "add-poste-extra") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) posteExtraModal(client, found.poste, null);
    } else if (action === "edit-poste-extra") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) {
        const extra = (found.poste.extras || []).find((ex) => ex.id === btn.dataset.extraId);
        posteExtraModal(client, found.poste, extra);
      }
    } else if (action === "delete-poste-extra") {
      const found = findPosteIti(client, btn.dataset.posteId);
      if (found) {
        found.poste.extras = (found.poste.extras || []).filter((ex) => ex.id !== btn.dataset.extraId);
        client.updatedAt = Date.now();
        Store.upsertClient(client);
        renderClientView();
      }
    }
  });

  // ---------- Croquis à main levée ----------

  const sketchOverlay = document.getElementById("sketch-overlay");
  const sketchCanvas = document.getElementById("sketch-canvas");
  const sketchCtx = sketchCanvas.getContext("2d");
  const sketchClose = document.getElementById("sketch-close");
  const sketchSave = document.getElementById("sketch-save");
  const sketchUndo = document.getElementById("sketch-undo");
  const sketchClear = document.getElementById("sketch-clear");
  const sketchEraser = document.getElementById("sketch-eraser");
  const sketchColorBtns = Array.from(document.querySelectorAll(".sketch-color"));

  const modeLineBtn = document.getElementById("mode-line");
  const modeFreehandBtn = document.getElementById("mode-freehand");
  const modeRectangleBtn = document.getElementById("mode-rectangle");
  const modeTriangleBtn = document.getElementById("mode-triangle");
  const modeFenetreBtn = document.getElementById("mode-fenetre");
  const modePorteBtn = document.getElementById("mode-porte");
  const modeTexteBtn = document.getElementById("mode-texte");

  let sketchClient = null;
  let sketchFacade = null;
  let currentColor = "#1b2430";
  let isErasing = false;
  let drawing = false;
  let lastPoint = null;
  let undoStack = [];
  let sketchMode = "ligne"; // "ligne" | "libre" | "rectangle" | "triangle" | "fenetre" | "porte" | "texte"
  let strokeStart = null;
  let strokeBaseImageData = null;

  // ---------- Accrochage aux points (snapping) ----------
  // Permet de refermer précisément des formes complexes (pignons irréguliers, décrochés...)
  // dessinées trait par trait : en s'approchant d'un point déjà posé, le tracé s'y accroche.
  const SNAP_THRESHOLD = 18;
  const SNAPPABLE_MODES = ["ligne", "rectangle", "triangle", "fenetre", "porte"];
  let sketchSnapPoints = [];

  function snapPoint(pt) {
    let best = null;
    let bestDist = SNAP_THRESHOLD;
    for (const p of sketchSnapPoints) {
      const d = Math.hypot(pt.x - p.x, pt.y - p.y);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best || pt;
  }

  function addSnapPoints(points) {
    sketchSnapPoints.push(...points);
    if (sketchSnapPoints.length > 400) sketchSnapPoints.splice(0, sketchSnapPoints.length - 400);
  }

  // Suivi d'un contour en cours de tracé (plusieurs traits "Ligne droite" mis bout à bout) :
  // dès que le dernier trait revient sur le tout premier point, on calcule la surface réelle
  // à partir des cotes saisies sur chaque trait (échelle moyenne cote réelle / longueur pixel).
  // Tous les traits "Ligne droite" de la session, quel que soit l'ordre/sens dans lequel
  // ils ont été dessinés. Dès qu'un nouveau trait referme une boucle avec d'autres traits
  // déjà posés (peu importe l'ordre), la surface est calculée automatiquement.
  let sketchLineSegments = []; // [{ a:{x,y}, b:{x,y}, cote:number|null }, ...]

  function resetLineSegments() {
    sketchLineSegments = [];
  }

  function polygonPixelArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const p1 = points[i];
      const p2 = points[(i + 1) % points.length];
      sum += p1.x * p2.y - p2.x * p1.y;
    }
    return Math.abs(sum) / 2;
  }

  function pointKey(p) {
    return Math.round(p.x) + "," + Math.round(p.y);
  }

  // Recherche (DFS) un chemin qui referme une boucle en repartant du trait qu'on vient de
  // tracer, en empruntant n'importe quels autres traits déjà posés, dans n'importe quel ordre.
  function findClosedLoop(newSeg) {
    const adj = new Map();
    function addToAdj(seg) {
      const ka = pointKey(seg.a), kb = pointKey(seg.b);
      if (!adj.has(ka)) adj.set(ka, []);
      if (!adj.has(kb)) adj.set(kb, []);
      adj.get(ka).push({ to: seg.b, toKey: kb, seg });
      adj.get(kb).push({ to: seg.a, toKey: ka, seg });
    }
    for (const seg of sketchLineSegments) addToAdj(seg);

    const startKey = pointKey(newSeg.a);
    const visited = new Set([newSeg]);
    const pathPoints = [newSeg.a, newSeg.b];
    const pathCotes = [newSeg.cote];

    function dfs(currentKey) {
      if (currentKey === startKey && pathPoints.length >= 4) return true;
      const neighbors = adj.get(currentKey) || [];
      for (const edge of neighbors) {
        if (visited.has(edge.seg)) continue;
        visited.add(edge.seg);
        pathPoints.push(edge.to);
        pathCotes.push(edge.seg.cote);
        if (dfs(edge.toKey)) return true;
        pathPoints.pop();
        pathCotes.pop();
        visited.delete(edge.seg);
      }
      return false;
    }

    if (dfs(pointKey(newSeg.b))) {
      return { vertices: pathPoints, cotes: pathCotes, usedSegs: Array.from(visited) };
    }
    return null;
  }

  function shapeCornerPoints(mode, shape) {
    if (mode === "triangle") {
      return [
        { x: shape.x, y: shape.y + shape.h },
        { x: shape.x + shape.w, y: shape.y + shape.h },
        { x: shape.x + shape.w / 2, y: shape.y },
      ];
    }
    return [
      { x: shape.x, y: shape.y },
      { x: shape.x + shape.w, y: shape.y },
      { x: shape.x, y: shape.y + shape.h },
      { x: shape.x + shape.w, y: shape.y + shape.h },
    ];
  }

  function drawRectShape(ctx, x0, y0, x1, y1, color) {
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.strokeRect(x, y, w, h);
    return { x, y, w, h };
  }

  function drawTriangleShape(ctx, x0, y0, x1, y1, color) {
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w / 2, y);
    ctx.closePath();
    ctx.stroke();
    return { x, y, w, h };
  }

  function drawWindowShape(ctx, x0, y0, x1, y1, color) {
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y);
    ctx.lineTo(x + w / 2, y + h);
    ctx.moveTo(x, y + h / 2);
    ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();
    return { x, y, w, h };
  }

  function drawDoorShape(ctx, x0, y0, x1, y1, color) {
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);
    const r = Math.min(w, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h - r);
    ctx.lineTo(x, y + h);
    ctx.arc(x, y + h, r, -Math.PI / 2, 0);
    ctx.stroke();
    return { x, y, w, h };
  }

  const SHAPE_DRAW_FNS = {
    rectangle: drawRectShape,
    triangle: drawTriangleShape,
    fenetre: drawWindowShape,
    porte: drawDoorShape,
  };

  const SKETCH_FONT = "16px -apple-system, Segoe UI, Roboto, Arial, sans-serif";

  // Cote de largeur centrée au-dessus du haut de la forme (ou en dessous de la base pour un
  // triangle), cote de hauteur sur le côté (texte vertical).
  function drawShapeDimensions(ctx, shape, widthText, heightText, color, widthBelow) {
    ctx.font = SKETCH_FONT;
    ctx.fillStyle = color;

    if (widthText) {
      ctx.textAlign = "center";
      ctx.textBaseline = widthBelow ? "top" : "bottom";
      ctx.fillText(widthText, shape.x + shape.w / 2, widthBelow ? shape.y + shape.h + 6 : shape.y - 6);
    }
    if (heightText) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.translate(shape.x - 8, shape.y + shape.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(heightText, 0, 0);
      ctx.restore();
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  function drawFreeText(ctx, text, x, y, color) {
    if (!text) return;
    ctx.font = SKETCH_FONT;
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
  }

  // Cote d'un trait : affichée au-dessus du milieu du segment (décalée perpendiculairement
  // pour ne pas être coupée par le trait), quelle que soit son orientation.
  function drawLineLabel(ctx, text, p1, p2, color) {
    if (!text) return;
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    let px = -dy / len;
    let py = dx / len;
    if (py > 0) { px = -px; py = -py; } // toujours afficher du côté "haut" de la ligne
    const offset = 12;
    ctx.font = SKETCH_FONT;
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(text, midX + px * offset, midY + py * offset);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  function sketchResizeCanvas() {
    const wrap = sketchCanvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;

    // Préserve le dessin existant lors d'un redimensionnement (ex: rotation tablette)
    const prev = sketchCanvas.width ? sketchCanvas.toDataURL() : null;

    sketchCanvas.width = rect.width * ratio;
    sketchCanvas.height = rect.height * ratio;
    sketchCanvas.style.width = rect.width + "px";
    sketchCanvas.style.height = rect.height + "px";
    sketchCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    sketchCtx.lineCap = "round";
    sketchCtx.lineJoin = "round";
    sketchCtx.fillStyle = "#ffffff";
    sketchCtx.fillRect(0, 0, rect.width, rect.height);

    if (prev) {
      const img = new Image();
      img.onload = () => sketchCtx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = prev;
    }
  }

  function openSketchEditor(client, facade) {
    sketchClient = client;
    sketchFacade = facade;
    undoStack = [];
    sketchSnapPoints = [];
    resetLineSegments();
    sketchOverlay.hidden = false;
    document.body.style.overflow = "hidden";

    // getBoundingClientRect force un recalcul de mise en page synchrone : pas besoin
    // d'attendre requestAnimationFrame (qui ne se déclenche pas si l'onglet est en arrière-plan).
    const wrap = sketchCanvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    sketchCanvas.width = rect.width * ratio;
    sketchCanvas.height = rect.height * ratio;
    sketchCanvas.style.width = rect.width + "px";
    sketchCanvas.style.height = rect.height + "px";
    sketchCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    sketchCtx.lineCap = "round";
    sketchCtx.lineJoin = "round";
    sketchCtx.fillStyle = "#ffffff";
    sketchCtx.fillRect(0, 0, rect.width, rect.height);

    if (facade.sketch) {
      const img = new Image();
      img.onload = () => sketchCtx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = facade.sketch;
    }
  }

  function closeSketchEditor() {
    sketchOverlay.hidden = true;
    document.body.style.overflow = "";
    sketchClient = null;
    sketchFacade = null;
    renderClientView();
  }

  function pushUndoSnapshot() {
    if (undoStack.length > 25) undoStack.shift();
    undoStack.push(sketchCanvas.toDataURL());
  }

  function getPoint(e) {
    const rect = sketchCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  let lastMovePoint = null;

  sketchCanvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    pushUndoSnapshot();
    let point = getPoint(e);
    if (SNAPPABLE_MODES.includes(sketchMode)) point = snapPoint(point);
    lastPoint = point;
    lastMovePoint = point;
    strokeStart = point;
    if (sketchMode !== "libre" && sketchMode !== "texte") {
      strokeBaseImageData = sketchCtx.getImageData(0, 0, sketchCanvas.width, sketchCanvas.height);
    }
    sketchCanvas.setPointerCapture(e.pointerId);
  });

  sketchCanvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    if (sketchMode === "texte") return;
    let point = getPoint(e);
    if (SNAPPABLE_MODES.includes(sketchMode)) point = snapPoint(point);
    lastMovePoint = point;
    sketchCtx.strokeStyle = isErasing ? "#ffffff" : currentColor;
    sketchCtx.lineWidth = isErasing ? 24 : 3.5;

    if (sketchMode === "ligne") {
      sketchCtx.putImageData(strokeBaseImageData, 0, 0);
      sketchCtx.beginPath();
      sketchCtx.moveTo(strokeStart.x, strokeStart.y);
      sketchCtx.lineTo(point.x, point.y);
      sketchCtx.stroke();
    } else if (SHAPE_DRAW_FNS[sketchMode]) {
      sketchCtx.putImageData(strokeBaseImageData, 0, 0);
      SHAPE_DRAW_FNS[sketchMode](sketchCtx, strokeStart.x, strokeStart.y, point.x, point.y, currentColor);
    } else {
      sketchCtx.beginPath();
      sketchCtx.moveTo(lastPoint.x, lastPoint.y);
      sketchCtx.lineTo(point.x, point.y);
      sketchCtx.stroke();
      lastPoint = point;
    }
  });

  const SHAPE_DIMENSION_PROMPTS = {
    rectangle: { width: "Largeur (ex: 8.00) :", height: "Hauteur (ex: 2.50) :" },
    triangle: { width: "Largeur de la base du pignon (ex: 6.00) :", height: "Hauteur du pignon (ex: 1.50) :" },
    fenetre: { width: "Largeur de la fenêtre (ex: 1.20) :", height: "Hauteur de la fenêtre (ex: 1.20) :" },
    porte: { width: "Largeur de la porte (ex: 0.90) :", height: "Hauteur de la porte (ex: 2.10) :" },
  };

  const ZONE_MODES = ["rectangle", "triangle"];
  const OPENING_SKETCH_MODES = ["fenetre", "porte"];

  function askZoneKind() {
    const raw = window.prompt(
      "Cette zone est-elle à AJOUTER à la surface (tapez A), à DÉDUIRE sans facturation (tapez D), ou à facturer à part avec un prix personnalisé (tapez son nom, ex: Peinture, RPE simple) ?",
      "A"
    );
    if (raw === null) return null; // annulé : la zone n'est pas créée
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.toUpperCase() === "A") return { kind: "ajout", label: "" };
    if (trimmed.toUpperCase() === "D") return { kind: "deduit", label: "" };
    return { kind: "autre", label: trimmed };
  }

  function endStroke(e) {
    if (!drawing) return;
    drawing = false;

    const dimPrompts = SHAPE_DIMENSION_PROMPTS[sketchMode];
    if (dimPrompts && strokeStart && lastMovePoint) {
      const moved = Math.abs(lastMovePoint.x - strokeStart.x) > 4 || Math.abs(lastMovePoint.y - strokeStart.y) > 4;
      if (moved) {
        const shape = {
          x: Math.min(strokeStart.x, lastMovePoint.x),
          y: Math.min(strokeStart.y, lastMovePoint.y),
          w: Math.abs(lastMovePoint.x - strokeStart.x),
          h: Math.abs(lastMovePoint.y - strokeStart.y),
        };
        addSnapPoints(shapeCornerPoints(sketchMode, shape));
        const widthText = window.prompt(dimPrompts.width, "");
        const heightText = window.prompt(dimPrompts.height, "");
        const isZoneMode = ZONE_MODES.includes(sketchMode);
        const w = parseFloat((widthText || "").replace(",", "."));
        const h = parseFloat((heightText || "").replace(",", "."));

        if (isZoneMode && sketchClient && sketchFacade && w > 0 && h > 0) {
          const zoneKind = askZoneKind();
          if (zoneKind) {
            const suffix = zoneKind.kind === "deduit" ? " (déduit)" : zoneKind.kind === "autre" ? ` (${zoneKind.label})` : "";
            drawShapeDimensions(sketchCtx, shape, (widthText || "") + suffix, heightText, currentColor, sketchMode === "triangle");
            if (!sketchFacade.zones) sketchFacade.zones = [];
            sketchFacade.zones.push({
              id: uid(),
              type: sketchMode,
              width: w,
              height: h,
              kind: zoneKind.kind,
              label: zoneKind.label,
              prix: 0,
              tva: DEFAULT_TVA,
            });
            sketchClient.updatedAt = Date.now();
            Store.upsertClient(sketchClient);
          } else {
            drawShapeDimensions(sketchCtx, shape, widthText, heightText, currentColor, sketchMode === "triangle");
          }
        } else if (OPENING_SKETCH_MODES.includes(sketchMode) && sketchClient && sketchFacade && w > 0 && h > 0) {
          // Dessiner une fenêtre/porte crée une vraie ouverture : elle compte dans la surface nette,
          // les tableaux et les appuis, comme si elle avait été ajoutée via le bouton "+ Fenêtre"/"+ Porte".
          sketchFacade.ouvertures.push({ id: uid(), type: sketchMode, largeur: w, hauteur: h, qty: 1 });
          sketchClient.updatedAt = Date.now();
          Store.upsertClient(sketchClient);
          drawShapeDimensions(sketchCtx, shape, widthText, heightText, currentColor, false);
        } else {
          drawShapeDimensions(sketchCtx, shape, widthText, heightText, currentColor, sketchMode === "triangle");
        }
      }
    } else if (sketchMode === "ligne" && strokeStart && lastMovePoint) {
      const moved = Math.abs(lastMovePoint.x - strokeStart.x) > 4 || Math.abs(lastMovePoint.y - strokeStart.y) > 4;
      if (moved) {
        addSnapPoints([strokeStart, lastMovePoint]);
        const coteText = window.prompt("Longueur de ce trait (ex: 3.50) — laissez vide pour ne pas coter :", "");
        if (coteText) drawLineLabel(sketchCtx, coteText, strokeStart, lastMovePoint, currentColor);
        const coteValue = parseFloat((coteText || "").replace(",", "."));

        const newSeg = { a: strokeStart, b: lastMovePoint, cote: coteValue > 0 ? coteValue : null };
        sketchLineSegments.push(newSeg);

        // Peu importe l'ordre ou le sens dans lequel les traits ont été dessinés : on cherche
        // si celui-ci referme une boucle avec d'autres traits déjà posés.
        const loop = findClosedLoop(newSeg);
        if (loop) {
          const vertices = loop.vertices.slice(0, -1);
          const knownScales = [];
          for (let i = 0; i < vertices.length; i++) {
            const cote = loop.cotes[i];
            if (cote) {
              const pixelLen = Math.hypot(loop.vertices[i + 1].x - vertices[i].x, loop.vertices[i + 1].y - vertices[i].y) || 1;
              knownScales.push(cote / pixelLen);
            }
          }
          if (knownScales.length > 0 && sketchClient && sketchFacade) {
            const scale = knownScales.reduce((s, v) => s + v, 0) / knownScales.length;
            const realArea = polygonPixelArea(vertices) * scale * scale;

            const zoneKind = askZoneKind();
            if (zoneKind) {
              if (!sketchFacade.zones) sketchFacade.zones = [];
              sketchFacade.zones.push({
                id: uid(),
                type: "polygone",
                area: round2(realArea),
                kind: zoneKind.kind,
                label: zoneKind.label,
                prix: 0,
                tva: DEFAULT_TVA,
              });
              sketchClient.updatedAt = Date.now();
              Store.upsertClient(sketchClient);

              const cx = vertices.reduce((s, p) => s + p.x, 0) / vertices.length;
              const cy = vertices.reduce((s, p) => s + p.y, 0) / vertices.length;
              const suffix = zoneKind.kind === "deduit" ? " (déduit)" : zoneKind.kind === "autre" ? ` (${zoneKind.label})` : "";
              drawFreeText(sketchCtx, `${fmt(round2(realArea), "m²")}${suffix}`, cx - 20, cy, currentColor);

              sketchLineSegments = sketchLineSegments.filter((s) => loop.usedSegs.indexOf(s) === -1);
            }
          } else if (knownScales.length === 0) {
            alert("Forme refermée, mais aucune côte n'a été renseignée sur ses traits : impossible de calculer la surface. Redessinez en indiquant au moins une longueur.");
          }
        }
      }
    } else if (sketchMode === "texte" && strokeStart) {
      const text = window.prompt("Texte à ajouter :", "");
      if (text) drawFreeText(sketchCtx, text, strokeStart.x, strokeStart.y, currentColor);
    }

    lastPoint = null;
    lastMovePoint = null;
    strokeStart = null;
    strokeBaseImageData = null;
    try { sketchCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  sketchCanvas.addEventListener("pointerup", endStroke);
  sketchCanvas.addEventListener("pointercancel", endStroke);
  sketchCanvas.addEventListener("pointerleave", endStroke);

  const modeButtons = [
    { btn: modeLineBtn, mode: "ligne" },
    { btn: modeFreehandBtn, mode: "libre" },
    { btn: modeRectangleBtn, mode: "rectangle" },
    { btn: modeTriangleBtn, mode: "triangle" },
    { btn: modeFenetreBtn, mode: "fenetre" },
    { btn: modePorteBtn, mode: "porte" },
    { btn: modeTexteBtn, mode: "texte" },
  ];
  modeButtons.forEach(({ btn, mode }) => {
    btn.addEventListener("click", () => {
      if (mode !== "ligne") resetLineSegments();
      sketchMode = mode;
      modeButtons.forEach(({ btn: b }) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  sketchColorBtns.forEach((b) => {
    b.addEventListener("click", () => {
      currentColor = b.dataset.color;
      isErasing = false;
      sketchColorBtns.forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      sketchEraser.classList.remove("active");
    });
  });

  sketchEraser.addEventListener("click", () => {
    isErasing = !isErasing;
    sketchEraser.classList.toggle("active", isErasing);
  });

  sketchUndo.addEventListener("click", () => {
    const prev = undoStack.pop();
    if (!prev) return;
    const img = new Image();
    img.onload = () => {
      const rect = sketchCanvas.getBoundingClientRect();
      sketchCtx.clearRect(0, 0, rect.width, rect.height);
      sketchCtx.drawImage(img, 0, 0, rect.width, rect.height);
    };
    img.src = prev;
  });

  sketchClear.addEventListener("click", () => {
    if (!confirm("Effacer tout le croquis ?")) return;
    pushUndoSnapshot();
    const rect = sketchCanvas.getBoundingClientRect();
    sketchCtx.fillStyle = "#ffffff";
    sketchCtx.fillRect(0, 0, rect.width, rect.height);
    sketchSnapPoints = [];
    resetLineSegments();
  });

  sketchClose.addEventListener("click", closeSketchEditor);

  sketchSave.addEventListener("click", () => {
    if (!sketchClient || !sketchFacade) return;
    sketchFacade.sketch = sketchCanvas.toDataURL("image/png");
    sketchClient.updatedAt = Date.now();
    Store.upsertClient(sketchClient);
    closeSketchEditor();
  });

  window.addEventListener("resize", () => {
    if (!sketchOverlay.hidden) sketchResizeCanvas();
  });

  // ---------- Récapitulatif imprimable (PDF via impression du navigateur) ----------

  function printHeaderHtml(client, title) {
    const adresse = clientAdresseChantier(client);
    const dateVisite = clientDateVisite(client);
    return `
      <div class="print-header">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <div class="print-client-info">
            <strong>${escapeHtml(clientFullName(client))}</strong><br>
            ${adresse ? escapeHtml(adresse) + "<br>" : ""}
            ${client.codePostal ? escapeHtml(client.codePostal) + "<br>" : ""}
            ${client.telephone ? "Tél : " + escapeHtml(client.telephone) + "<br>" : ""}
            ${client.email ? "Mail : " + escapeHtml(client.email) + "<br>" : ""}
            ${dateVisite ? "Visite technique : " + formatDate(dateVisite) : ""}
          </div>
        </div>
        <img src="icons/icon-512.png" alt="Logo">
      </div>
      ${client.notes ? `<p><em>${escapeHtml(client.notes)}</em></p>` : ""}
    `;
  }

  function buildIteReportHtml(client) {
    const t = computeClientTotals(client);
    const m2 = getPrixEntry(client, "m2");
    const tab = getPrixEntry(client, "tableau");
    const app = getPrixEntry(client, "appui");
    const lineM2 = htTtc(t.nette * m2.prix, m2.tva);
    const lineTab = htTtc(t.tableau * tab.prix, tab.tva);
    const lineApp = htTtc(t.appui * app.prix, app.tva);
    const iteTotals = computeIteTotals(client);
    const extrasTotals = computeClientExtrasTotals(client);
    const grandHt = iteTotals.ht + extrasTotals.ht;
    const grandTtc = iteTotals.ttc + extrasTotals.ttc;

    const facadesHtml = client.facades.map((f) => {
      const c = computeFacade(f);

      const openingsRows = f.ouvertures.map((o) => {
        const oc = computeOpening(o);
        const typeInfo = OPENING_TYPES[o.type];
        return `<tr>
          <td>${typeInfo.label}</td>
          <td>${o.largeur.toFixed(2)} × ${o.hauteur.toFixed(2)} m ${o.qty > 1 ? "× " + o.qty : ""}</td>
          <td>${fmt(oc.surface, "m²")}</td>
          <td>${fmt(oc.tableau, "ml")}</td>
          <td>${typeInfo.hasAppui ? fmt(oc.appui, "ml") : "-"}</td>
        </tr>`;
      }).join("");

      const extrasRows = EXTRAS_CATALOG.map((item) => {
        const e = getExtraEntry(f, item.key);
        if (!e.qty) return "";
        const line = htTtc(e.qty * e.prix, e.tva);
        return `<tr><td>${escapeHtml(item.label)}</td><td>${e.qty} ${item.unit}</td><td>${fmt(e.prix, "€")}</td><td>${fmt(line.ht, "€")}</td><td>${fmt(line.ttc, "€")}</td></tr>`;
      }).join("");

      const autreZonesRows = (f.zones || []).filter((z) => z.kind === "autre").map((z) => {
        const a = zoneArea(z);
        const line = htTtc(a * (z.prix || 0), z.tva);
        return `<tr><td>${escapeHtml(z.label)}</td><td>${fmt(a, "m²")}</td><td>${fmt(z.prix, "€")}</td><td>${fmt(line.ht, "€")}</td><td>${fmt(line.ttc, "€")}</td></tr>`;
      }).join("");

      const customExtrasRows = getFacadeCustomExtras(f).map((ex) => {
        const line = htTtc((ex.qty || 0) * (ex.prix || 0), ex.tva);
        return `<tr><td>${escapeHtml(ex.label)}</td><td>${ex.qty} ${escapeHtml(ex.unit)}</td><td>${fmt(ex.prix, "€")}</td><td>${fmt(line.ht, "€")}</td><td>${fmt(line.ttc, "€")}</td></tr>`;
      }).join("");

      const sketchHtml = f.sketch ? `<img src="${f.sketch}">` : "";
      const photosHtml = (f.photos || []).map((p) => `<img src="${p.dataUrl}">`).join("");

      return `
        <div class="print-section">
          <h3>${escapeHtml(f.nom)} <span class="print-badge">${escapeHtml(systemeLabel(f.systeme))}</span></h3>
          <p>Surface brute : ${fmt(c.brute, "m²")} — Surface nette à isoler : ${fmt(c.nette, "m²")} — Tableaux : ${fmt(c.tableau, "ml")} — Appuis : ${fmt(c.appui, "ml")}</p>
          ${(sketchHtml || photosHtml) ? `<div class="print-photos">
            ${sketchHtml ? `<div class="print-photo-block"><span class="print-photo-label">Croquis</span>${sketchHtml}</div>` : ""}
            ${photosHtml ? `<div class="print-photo-block"><span class="print-photo-label">Photos</span><div class="print-photos-inline">${photosHtml}</div></div>` : ""}
          </div>` : ""}
          ${openingsRows ? `<table class="print-table"><thead><tr><th>Ouverture</th><th>Dimensions</th><th>Surface</th><th>Tableau</th><th>Appui</th></tr></thead><tbody>${openingsRows}</tbody></table>` : ""}
          ${(extrasRows || autreZonesRows || customExtrasRows) ? `<table class="print-table"><thead><tr><th>Élément complémentaire</th><th>Qté</th><th>Prix HT</th><th>Total HT</th><th>Total TTC</th></tr></thead><tbody>${extrasRows}${autreZonesRows}${customExtrasRows}</tbody></table>` : ""}
        </div>
      `;
    }).join("");

    return `
      ${printHeaderHtml(client, "Récapitulatif Extérieur (ITE)")}
      ${facadesHtml || "<p>Aucune façade renseignée.</p>"}
      <h2>Totaux extérieur</h2>
      <table class="print-table">
        <thead><tr><th></th><th>Quantité</th><th>Prix HT</th><th>TVA</th><th>Total HT</th><th>Total TTC</th></tr></thead>
        <tbody>
          <tr><td>Surface nette</td><td>${fmt(t.nette, "m²")}</td><td>${fmt(m2.prix, "€")}</td><td>${m2.tva}%</td><td>${fmt(lineM2.ht, "€")}</td><td>${fmt(lineM2.ttc, "€")}</td></tr>
          <tr><td>Tableaux</td><td>${fmt(t.tableau, "ml")}</td><td>${fmt(tab.prix, "€")}</td><td>${tab.tva}%</td><td>${fmt(lineTab.ht, "€")}</td><td>${fmt(lineTab.ttc, "€")}</td></tr>
          <tr><td>Appuis</td><td>${fmt(t.appui, "ml")}</td><td>${fmt(app.prix, "€")}</td><td>${app.tva}%</td><td>${fmt(lineApp.ht, "€")}</td><td>${fmt(lineApp.ttc, "€")}</td></tr>
        </tbody>
      </table>
      <div class="print-total-row"><span>Total éléments complémentaires</span><span>HT ${fmt(extrasTotals.ht, "€")} / TTC ${fmt(extrasTotals.ttc, "€")}</span></div>
      <div class="print-grand-total">Total Extérieur : ${fmt(grandHt, "€")} HT — ${fmt(grandTtc, "€")} TTC</div>
    `;
  }

  function buildItiReportHtml(client) {
    const iti = getClientIti(client);

    const zonesHtml = iti.zones.map((zone) => {
      const zc = computeZoneIti(zone);
      const postesHtml = (zone.postes || []).map((poste) => {
        const c = computePoste(poste);
        const isolantLabel = poste.isolant ? (poste.isolant === "autre" ? (poste.isolantAutre || "Autre") : ISOLANT_ITI_LABELS[poste.isolant]) : "";
        const specsParts = [];
        if (isolantLabel) specsParts.push(`Isolant : ${isolantLabel}${poste.epaisseur ? ` (${poste.epaisseur})` : ""}`);
        if (poste.support) specsParts.push(`Support : ${poste.support}`);
        if (poste.parement) specsParts.push(`Parement : ${poste.parement}`);
        if (poste.fixation) specsParts.push(`Fixation : ${poste.fixation}`);

        const mesuresRows = (poste.mesures || []).map((m) => {
          const photos = (m.photos || []).map((p) => `<img src="${p.dataUrl}">`).join("");
          return `<tr><td>${escapeHtml(m.localisation)}</td><td>${m.largeur.toFixed(2)} × ${m.hauteur.toFixed(2)} m ${m.qty > 1 ? "× " + m.qty : ""}</td><td>${fmt(computeMesureArea(m), "m²")}</td><td>${photos ? `<div class="print-photos-inline">${photos}</div>` : "-"}</td></tr>`;
        }).join("");

        const ouverturesRows = (poste.ouvertures || []).map((o) => {
          const oc = computePosteOpening(o);
          return `<tr><td>${ITI_OPENING_LABELS[o.type]}</td><td>${o.largeur.toFixed(2)} × ${o.hauteur.toFixed(2)} m ${o.qty > 1 ? "× " + o.qty : ""}</td><td>${fmt(oc.surface, "m²")}</td><td>${oc.linteau > 0 ? fmt(oc.linteau, "ml") : "-"}</td></tr>`;
        }).join("");

        const extrasRows = (poste.extras || []).map((ex) => {
          const line = htTtc((ex.qty || 0) * (ex.prix || 0), ex.tva);
          return `<tr><td>${escapeHtml(ex.label)}${ex.taille ? ` (${escapeHtml(ex.taille)})` : ""}</td><td>${ex.qty} ${escapeHtml(ex.unit)}</td><td>${fmt(ex.prix, "€")}</td><td>${fmt(line.ht, "€")}</td><td>${fmt(line.ttc, "€")}</td></tr>`;
        }).join("");

        return `
          <div class="print-section">
            <h3>${escapeHtml(poste.type)}</h3>
            ${specsParts.length ? `<p>${specsParts.map(escapeHtml).join(" · ")}</p>` : ""}
            ${mesuresRows ? `<table class="print-table"><thead><tr><th>Localisation</th><th>Dimensions</th><th>Surface</th><th>Photo</th></tr></thead><tbody>${mesuresRows}</tbody></table>` : ""}
            ${ouverturesRows ? `<table class="print-table"><thead><tr><th>Ouverture déduite</th><th>Dimensions</th><th>Surface déduite</th><th>Linteau</th></tr></thead><tbody>${ouverturesRows}</tbody></table>` : ""}
            <p>Surface nette : ${fmt(c.surface, "m²")}${c.ouvSurface > 0 ? ` (brute ${fmt(c.surfaceBrute, "m²")})` : ""} — Prix HT/m² ${fmt(poste.prix, "€")}${c.linteauTotal > 0 ? ` · Linteau ${fmt(c.linteauTotal, "ml")} à ${fmt(poste.prixLinteau || 0, "€")}/ml` : ""} (TVA ${poste.tva}%) — Sous-total HT ${fmt(c.mainHt, "€")} / TTC ${fmt(c.mainTtc, "€")}</p>
            ${extrasRows ? `<table class="print-table"><thead><tr><th>Élément complémentaire</th><th>Qté</th><th>Prix HT</th><th>Total HT</th><th>Total TTC</th></tr></thead><tbody>${extrasRows}</tbody></table>` : ""}
          </div>
        `;
      }).join("");

      return `
        <h2>Zone : ${escapeHtml(zone.nom)}</h2>
        ${postesHtml || "<p>Aucun poste de travaux.</p>"}
        <div class="print-total-row"><span>Total zone ${escapeHtml(zone.nom)}</span><span>HT ${fmt(zc.ht, "€")} / TTC ${fmt(zc.ttc, "€")}</span></div>
      `;
    }).join("");

    const workTotals = computeItiWorkTotals(client);
    const extrasTotals = computeItiExtrasTotals(client);
    const grandHt = workTotals.ht + extrasTotals.ht;
    const grandTtc = workTotals.ttc + extrasTotals.ttc;

    return `
      ${printHeaderHtml(client, "Récapitulatif Intérieur (ITI)")}
      ${zonesHtml || "<p>Aucune zone renseignée.</p>"}
      <div class="print-grand-total">Total Intérieur : ${fmt(grandHt, "€")} HT — ${fmt(grandTtc, "€")} TTC</div>
    `;
  }

  function printReport(bodyHtml) {
    printAreaEl.innerHTML = `<div class="print-doc">${bodyHtml}</div>`;
    window.print();
  }

  document.getElementById("btn-print-ite").addEventListener("click", () => {
    const client = Store.getClient(currentClientId);
    if (!client) return;
    printReport(buildIteReportHtml(client));
  });

  document.getElementById("btn-print-iti").addEventListener("click", () => {
    const client = Store.getClient(currentClientId);
    if (!client) return;
    printReport(buildItiReportHtml(client));
  });

  // ---------- Téléchargement du récap en PDF (en plus de l'impression) ----------
  // Rendu de #print-area hors-écran (voir .pdf-render en CSS) puis capture en image
  // (html2canvas) découpée sur autant de pages A4 que nécessaire (jsPDF), pour obtenir
  // un vrai fichier .pdf téléchargé plutôt que de passer par la boîte de dialogue d'impression.

  async function downloadReportPdf(client, bodyHtml, filenamePrefix, btn) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "⏳ Génération du PDF...";
    try {
      printAreaEl.innerHTML = `<div class="print-doc">${bodyHtml}</div>`;
      printAreaEl.classList.add("pdf-render");
      // Laisse le temps au navigateur de peindre les images (croquis, photos) avant capture.
      await new Promise((resolve) => setTimeout(resolve, 80));

      const target = printAreaEl.querySelector(".print-doc");
      const canvas = await html2canvas(target, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });

      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: "pt", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = pageWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      const imgData = canvas.toDataURL("image/jpeg", 0.92);

      let heightLeft = imgHeight;
      let position = 0;
      pdf.addImage(imgData, "JPEG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
      while (heightLeft > 0) {
        position -= pageHeight;
        pdf.addPage();
        pdf.addImage(imgData, "JPEG", 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      const safeName = clientFullName(client).replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "client";
      pdf.save(`${filenamePrefix}_${safeName}.pdf`);
    } catch (err) {
      console.error("Échec de génération du PDF", err);
      alert("Échec de la génération du PDF. Réessayez, ou utilisez le bouton Imprimer.");
    } finally {
      printAreaEl.classList.remove("pdf-render");
      printAreaEl.innerHTML = "";
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  document.getElementById("btn-download-ite").addEventListener("click", (e) => {
    const client = Store.getClient(currentClientId);
    if (!client) return;
    downloadReportPdf(client, buildIteReportHtml(client), "Recap_Exterieur", e.currentTarget);
  });

  document.getElementById("btn-download-iti").addEventListener("click", (e) => {
    const client = Store.getClient(currentClientId);
    if (!client) return;
    downloadReportPdf(client, buildItiReportHtml(client), "Recap_Interieur", e.currentTarget);
  });

  // ---------- PWA : service worker (fonctionnement hors ligne) ----------

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.error("Échec de l'enregistrement du service worker", err);
      });
    });
  }

  // ---------- Démarrage ----------
  // L'affichage initial (écran de connexion ou liste clients) est déclenché par
  // auth.onAuthStateChanged ci-dessus, dès que Firebase a déterminé si un compte est connecté.
})();
