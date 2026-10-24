// Leitstand: kleine Hilfen, die Konsole funktioniert auch ohne JavaScript (der Server prüft alles selbst).
document.addEventListener('DOMContentLoaded', () => {
  // Löschknopf erst aktiv, wenn die Subdomain korrekt eingetippt ist.
  for (const f of document.querySelectorAll('form[data-bestaetigen]')) {
    const soll = f.getAttribute('data-bestaetigen');
    const feld = f.querySelector('input[name="bestaetigung"]');
    const knopf = f.querySelector('[data-bestaetigen-knopf]');
    if (!feld || !knopf) continue;
    const pruefe = () => { knopf.disabled = feld.value.trim() !== soll; };
    feld.addEventListener('input', pruefe);
    pruefe();
  }
  // Felder für ein neues Konto ausblenden, wenn ein bestehendes gewählt ist.
  const wahl = document.getElementById('kunde_id');
  const neu = document.querySelector('[data-neu-konto]');
  if (wahl && neu) {
    const zeige = () => { neu.hidden = wahl.value !== ''; };
    wahl.addEventListener('change', zeige);
    zeige();
  }
  // Stufe „Eigene Maschine“ nur ohne Testphase.
  const zahlung = document.getElementById('zahlung');
  const stufe = document.getElementById('stufe');
  if (zahlung && stufe) {
    const passe = () => {
      const test = zahlung.value === 'test';
      stufe.querySelector('option[value="eigen"]').disabled = test;
      if (test) stufe.value = 'geteilt';
    };
    zahlung.addEventListener('change', passe);
    passe();
  }
  // Mehrfaches Absenden verhindern (Idempotenz schützt zusätzlich serverseitig).
  for (const f of document.querySelectorAll('form[method="post"]')) {
    f.addEventListener('submit', () => { for (const b of f.querySelectorAll('button[type="submit"]')) setTimeout(() => { b.disabled = true; }, 0); });
  }
});
