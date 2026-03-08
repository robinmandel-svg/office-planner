# Office Planner UI (Next.js)

## Run

1. Install Node.js 18+
2. Install dependencies

```bash
npm install
```

3. Start dev server

```bash
npm run dev
```

Open `http://localhost:3000`.

## What is included

- Integrated planner API: `POST /api/plan`
- UI configuration for benches, teams, pre-allocations, and flex policy
- CSV template download and CSV import
- Bench x day output table
- Diagnostics: unmet demand, fairness, occupancy, and mode comparison

## CSV templates

- `public/templates/benches.csv`
- `public/templates/teams.csv`
- `public/templates/preallocations.csv`
