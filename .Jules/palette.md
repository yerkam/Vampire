## 2024-10-26 - Screen Reader Accessibility in Turkish Language UI
**Learning:** Found multiple icon-only buttons (`+`/`-` steppers for game roles) and inputs missing explicit `<label>` elements. Since this is a Turkish language UI, it is crucial to ensure `aria-label` values are also localized (e.g., "Vampir sayısını artır") to match the application language for a consistent screen reader experience.
**Action:** Always verify the application language when adding `aria-label` attributes and ensure they are written in the matching locale (Turkish in this case).
