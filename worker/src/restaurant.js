// RÉGLAGES DU RESTAURANT — le seul fichier à adapter pour un nouveau client.
// Les prix viennent de menu.json, généré depuis index.html par tools/sync-menu.mjs.
import MENU from "./menu.json";

export const R = {
  name: "Aroma Gourmet",
  timeZone: "America/Toronto",
  tel: "438 531-6482",
  // Origines autorisées à envoyer des commandes (la page publique).
  origins: ["https://azuremuse.github.io"],
  menu: MENU,

  // Heures d'ouverture : 0 = dimanche … 6 = samedi ; null = fermé.
  hours: { 0:["11:00","21:30"], 1:["11:00","21:30"], 2:["11:00","22:00"], 3:["11:00","22:00"],
           4:["11:00","22:00"], 5:["11:00","23:00"], 6:["11:00","23:00"] },
  closedDates: ["2026-12-25", "2026-12-26"],   // jours fermés exceptionnels (AAAA-MM-JJ)
  leadMin: 20,         // délai minimum avant l'heure choisie
  lastOrderMin: 30,    // dernière commande X min avant la fermeture
  maxDaysAhead: 7,

  // Promotions : contrôlées par le serveur sur l'HEURE DE RETRAIT, pas sur l'heure de commande.
  promos: [
    { category: "rabais", days: [1,2,3,4,5], from: "11:00", to: "18:00" }   // du lundi au vendredi
  ],

  // Anti-abus.
  limits: {
    maxQtyPerLine: 20, maxItems: 40, maxSubtotal: 400,
    phonePerDay: 4, phonePending: 2, devicePerDay: 4, ipPerHour: 6,
    noShowsWarning: 2   // alerte « à bloquer ? » dans le tableau de bord ; le blocage reste manuel
  },

  // Relances quand une commande n'est pas acceptée (minutes après l'ouverture / la réception).
  escalation: { remindRestoMin: 5, alertAgencyMin: 8, expireMin: 20 },

  prepChoices: [10, 15, 20, 30, 45],
  retentionDays: 90,   // renseignements personnels effacés après ce délai (Loi 25)
};
