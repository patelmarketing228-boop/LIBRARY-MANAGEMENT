# Library Seat Management System

## Files
- `index.html`: public QR seat lookup and Razorpay renewal page.
- `admin.html`: Supabase Auth admin dashboard, seat grid, admission/cash renewal/vacating and QR downloads.
- `worker.js`: Cloudflare Worker creates Razorpay orders and verifies captured payments.
- `schema.sql`: database schema, RLS and atomic idempotent renewal RPC.

## 1. Supabase setup
1. Create a Supabase project and run `schema.sql` in SQL Editor.
2. In Project Settings -> API, copy Project URL and anon/publishable key into both HTML files.
3. Create the admin user in Authentication -> Users.
4. Give that user admin authorization by setting `app_metadata` to `{ "role": "admin" }` using a trusted server/admin method (never from the browser). Example with Supabase Admin API from a secure server: update the user's app metadata. Do not put the service role key in either HTML file.
5. Confirm the admin user can sign in and only admins can insert/update/delete seats under RLS.

## 2. Frontend configuration
In `index.html` set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `WORKER_URL`, and `RAZORPAY_KEY_ID`.
In `admin.html` set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `PUBLIC_SITE_URL` (the deployed student site origin, e.g. `https://your-site.pages.dev`).
Deploy the HTML files to Cloudflare Pages. `index.html?seat=12` is the QR destination.

## 3. Cloudflare Worker
Deploy `worker.js` as a module Worker. Add these Worker secrets/variables:
- Secret `SUPABASE_SERVICE_ROLE_KEY`
- Secret `RAZORPAY_KEY_SECRET`
- Variable `SUPABASE_URL`
- Variable `RAZORPAY_KEY_ID`
- Variable `ALLOWED_ORIGIN` = exact deployed Pages origin, e.g. `https://your-site.pages.dev`

Set `WORKER_URL` in `index.html` to the Worker URL. The Worker also serves `GET /seat?seat=12` for the student lookup. Use Razorpay test keys first, complete test payments, then switch to live keys. Enable payment capture in Razorpay or ensure payments are captured before verification.

## Important operational notes
- Student data is returned one seat at a time by the Worker, rather than granting the public anon key table-wide SELECT access. However, sequential seat numbers are guessable, so names and phone numbers can still be discovered by trying URLs. Get consent and strongly consider masking phone numbers or replacing sequential QR identifiers with random, hard-to-guess member tokens.
- The browser never marks a payment successful. Worker verifies HMAC signature and independently fetches payment/order from Razorpay before calling the atomic Supabase RPC.
- Cash renewals and new admissions are direct authenticated admin updates protected by RLS. The cash-renewal button requires an occupied seat.
- `30` and `90` days are used for validity. If the expiry is in the future, days are added to that date; if expired/empty, days are added from today.
- Tailwind CDN is convenient for a starter. For production, install Tailwind and build static CSS.
- Keep backups and test vacant/occupied/expired seats, failed payments, duplicate verification requests and simultaneous renewals before going live.
