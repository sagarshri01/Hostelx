# HostelX

A private OLX-style marketplace for hostel/college students.

## Features
- Student registration/login with JWT cookie auth
- Create listings with up to 6 images
- Categories, search, condition and price sorting
- Item details and seller profile
- Wishlist/favorites
- WhatsApp contact
- Mark items sold / delete listings
- Report listings
- Basic admin statistics
- MongoDB Atlas database

## Run locally

1. Install Node.js.
2. Create a MongoDB Atlas free deployment and copy its Node.js connection string.
3. Copy `.env.example` to `.env` and fill in `MONGODB_URI` and a strong `JWT_SECRET`.
4. Run:
   npm install
   npm start
5. Open http://localhost:3000

MongoDB's official Node.js driver documentation explains the Atlas connection setup:
https://www.mongodb.com/docs/drivers/node/current/get-started/

## Make yourself admin
After registering, open MongoDB Atlas and change your user's `role` field from `user` to `admin`. Then visit:
http://localhost:3000/#/admin

## Production notes
- Use HTTPS and set cookie `secure: true`.
- Put uploads in cloud object storage (e.g. Cloudinary/S3) instead of local disk.
- Add email/college-domain verification or an admin approval flow.
- Add rate limiting, CSRF protection and stronger validation before public deployment.
