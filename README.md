# 🥗 Meal Prep

A personal meal prep recipe manager built as my first full-stack 
web project. Designed for weekly meal planning — browse recipes, 
filter by dietary needs, select meals for the week, and 
auto-generate a smart grocery list.

## Features

- **Recipe Library** — store recipes with ingredients, 
  instructions, prep time, protein, cuisine, difficulty, 
  and cost estimate
- **Smart Filtering** — filter by difficulty, cuisine, cost, 
  and equipment; sort by prep time or protein; search by name; 
  slider controls for max prep time and min protein
- **Weekly Selection** — add recipes to a cart sidebar, 
  with a collapsible panel on desktop and a bottom drawer 
  on mobile
- **Grocery List Generation** — auto-generates a combined 
  ingredient list across all selected recipes, with smart 
  merging of duplicate ingredients across recipes
- **Serving Scaling** — adjust servings per recipe on the 
  checkout page and the grocery list scales automatically
- **Persistent Data** — all recipes, weekly selections, and 
  grocery lists saved to a cloud database (Supabase/PostgreSQL) 
  and accessible from any device
- **Mobile Responsive** — floating cart button with slide-up 
  drawer on mobile, full desktop layout on larger screens

## Tech Stack

- **Frontend** — vanilla HTML, CSS, JavaScript (no frameworks)
- **Database** — Supabase (PostgreSQL) with Row Level Security
- **Deployment** — Vercel
- **Tools** — Cursor AI, Git, GitHub

## Screenshots

*Coming soon*

## Local Development

1. Clone the repo
```
   git clone https://github.com/nirvansinha5/recipe-organizer.git
```
2. Create a `.env` file in the project root:
```
   SUPABASE_URL=your_supabase_project_url
   SUPABASE_ANON_KEY=your_supabase_anon_key
```
3. Serve locally:
```
   npx serve .
```
4. Open `http://localhost:3000/index.html`

## Database Setup

Run the SQL schema in `supabase/schema.sql` against your 
Supabase project to create the required tables and seed 
starter recipes.

## Project Background

This was my first coding project, built while learning 
full-stack development as a PM. I used Cursor AI as my 
primary development environment to go from zero coding 
experience to a deployed, database-backed web application.

---

Built by [Nirvan Sinha](https://github.com/nirvansinha5)
```