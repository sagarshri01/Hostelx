import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + path.extname(file.originalname).toLowerCase())
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => cb(null, /^image\\/(jpeg|png|webp|jpg)$/.test(file.mimetype))
});

const client = new MongoClient(process.env.MONGODB_URI);
let db, users, listings, favorites, reports;

async function initDB() {
  await client.connect();
  db = client.db("hostelx");
  users = db.collection("users");
  listings = db.collection("listings");
  favorites = db.collection("favorites");
  reports = db.collection("reports");
  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    listings.createIndex({ title: "text", description: "text" }),
    listings.createIndex({ category: 1, status: 1, createdAt: -1 })
  ]);
  console.log("MongoDB connected");
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(__dirname));
app.use("/uploads", express.static(uploadDir));

function tokenFor(user) {
  return jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
}
function auth(req, res, next) {
  try {
    const token = req.cookies.hostelx;
    if (!token) return res.status(401).json({ error: "Login required" });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: "Session expired" }); }
}
function admin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}
function oid(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, hostel, block, room, studentId } = req.body;
    if (!name || !email || !password || !hostel || !studentId) return res.status(400).json({ error: "Fill all required fields" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const exists = await users.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(409).json({ error: "Email already registered" });
    const user = {
      name: name.trim(), email: email.toLowerCase().trim(), password: await bcrypt.hash(password, 12),
      hostel: hostel.trim(), block: block?.trim() || "", room: room?.trim() || "",
      studentId: studentId.trim(), verified: false, role: "user", rating: 5, createdAt: new Date()
    };
    const result = await users.insertOne(user);
    user._id = result.insertedId;
    const token = tokenFor(user);
    res.cookie("hostelx", token, { httpOnly: true, sameSite: "lax", secure: false, maxAge: 7*24*60*60*1000 });
    const { password: _, ...safe } = user;
    res.json({ user: safe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  const user = await users.findOne({ email: req.body.email?.toLowerCase().trim() });
  if (!user || !(await bcrypt.compare(req.body.password || "", user.password))) return res.status(401).json({ error: "Invalid email or password" });
  res.cookie("hostelx", tokenFor(user), { httpOnly: true, sameSite: "lax", secure: false, maxAge: 7*24*60*60*1000 });
  const { password: _, ...safe } = user;
  res.json({ user: safe });
});

app.post("/api/auth/logout", (req, res) => { res.clearCookie("hostelx"); res.json({ ok: true }); });
app.get("/api/auth/me", auth, async (req, res) => {
  const user = await users.findOne({ _id: new ObjectId(req.user.id) }, { projection: { password: 0 } });
  res.json({ user });
});

app.get("/api/listings", async (req, res) => {
  const { q = "", category, min, max, condition, sort = "newest" } = req.query;
  const filter = { status: "available" };
  if (category && category !== "all") filter.category = category;
  if (condition && condition !== "all") filter.condition = condition;
  if (min) filter.price = { ...(filter.price || {}), $gte: Number(min) };
  if (max) filter.price = { ...(filter.price || {}), $lte: Number(max) };
  if (q.trim()) filter.$text = { $search: q.trim() };
  const sortObj = sort === "priceLow" ? { price: 1 } : sort === "priceHigh" ? { price: -1 } : { createdAt: -1 };
  const rows = await listings.find(filter).sort(sortObj).limit(60).toArray();
  res.json(rows);
});

app.get("/api/listings/:id", async (req, res) => {
  const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid listing" });
  const item = await listings.findOne({ _id: id });
  if (!item) return res.status(404).json({ error: "Listing not found" });
  const seller = await users.findOne({ _id: item.sellerId }, { projection: { password: 0, email: 0, room: 0 } });
  res.json({ ...item, seller });
});

app.post("/api/listings", auth, upload.array("images", 6), async (req, res) => {
  const { title, category, price, condition, description, originalPrice, location, urgent } = req.body;
  if (!title || !category || !price || !condition || !description) return res.status(400).json({ error: "Complete the listing form" });
  const imagePaths = (req.files || []).map(f => "/uploads/" + f.filename);
  const doc = {
    title: title.trim(), category, price: Number(price), originalPrice: originalPrice ? Number(originalPrice) : null,
    condition, description: description.trim(), location: location?.trim() || "",
    urgent: urgent === "true", images: imagePaths, sellerId: new ObjectId(req.user.id),
    status: "available", createdAt: new Date(), updatedAt: new Date(), views: 0
  };
  const result = await listings.insertOne(doc);
  res.json({ ...doc, _id: result.insertedId });
});

app.patch("/api/listings/:id", auth, async (req, res) => {
  const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid listing" });
  const item = await listings.findOne({ _id: id });
  if (!item || item.sellerId.toString() !== req.user.id) return res.status(403).json({ error: "Not your listing" });
  const allowed = ["title","price","description","condition","status","urgent"];
  const update = {}; allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = k === "price" ? Number(req.body[k]) : req.body[k]; });
  update.updatedAt = new Date();
  await listings.updateOne({ _id: id }, { $set: update });
  res.json({ ok: true });
});

app.delete("/api/listings/:id", auth, async (req, res) => {
  const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid listing" });
  const item = await listings.findOne({ _id: id });
  if (!item || (item.sellerId.toString() !== req.user.id && req.user.role !== "admin")) return res.status(403).json({ error: "Not allowed" });
  await listings.deleteOne({ _id: id });
  res.json({ ok: true });
});

app.post("/api/favorites/:id", auth, async (req, res) => {
  const listingId = oid(req.params.id); if (!listingId) return res.status(400).json({ error: "Invalid listing" });
  const query = { userId: new ObjectId(req.user.id), listingId };
  const found = await favorites.findOne(query);
  if (found) { await favorites.deleteOne({ _id: found._id }); return res.json({ saved: false }); }
  await favorites.insertOne({ ...query, createdAt: new Date() }); res.json({ saved: true });
});

app.get("/api/favorites", auth, async (req, res) => {
  const favs = await favorites.find({ userId: new ObjectId(req.user.id) }).toArray();
  const ids = favs.map(x => x.listingId);
  res.json(await listings.find({ _id: { $in: ids } }).sort({ createdAt: -1 }).toArray());
});

app.post("/api/reports", auth, async (req, res) => {
  const listingId = oid(req.body.listingId); if (!listingId) return res.status(400).json({ error: "Invalid listing" });
  await reports.insertOne({ listingId, reporterId: new ObjectId(req.user.id), reason: req.body.reason || "Other", status: "open", createdAt: new Date() });
  res.json({ ok: true });
});

app.get("/api/me/listings", auth, async (req, res) => {
  res.json(await listings.find({ sellerId: new ObjectId(req.user.id) }).sort({ createdAt: -1 }).toArray());
});

app.get("/api/admin/stats", auth, admin, async (_, res) => {
  const [students, active, sold, reportsOpen] = await Promise.all([
    users.countDocuments(), listings.countDocuments({ status: "available" }), listings.countDocuments({ status: "sold" }), reports.countDocuments({ status: "open" })
  ]);
  res.json({ students, active, sold, reportsOpen });
});

app.get("/api/admin/reports", auth, admin, async (_, res) => {
  res.json(await reports.find({ status: "open" }).sort({ createdAt: -1 }).limit(100).toArray());
});

app.patch("/api/admin/listings/:id", auth, admin, async (req, res) => {
  const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid listing" });
  await listings.updateOne({ _id: id }, { $set: { status: req.body.status, updatedAt: new Date() } });
  res.json({ ok: true });
});

app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

initDB().then(() => app.listen(PORT, () => console.log(`HostelX running at http://localhost:${PORT}`)))
  .catch(err => { console.error(err); process.exit(1); });
