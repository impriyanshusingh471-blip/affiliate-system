const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
require("dotenv").config();

const app = express();

// --------- CONFIG ----------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "changeme",
    resave: false,
    saveUninitialized: false,
  })
);

app.use(express.static(path.join(__dirname, "public")));

// --------- DB CONNECT ----------
mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("MongoDB connected");
    await ensureAdminUser();
  })
  .catch((err) => console.error("MongoDB error:", err));

// --------- MODELS ----------

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  passwordHash: String,
  referralCode: { type: String, unique: true },
  role: { type: String, enum: ["affiliate", "admin"], default: "affiliate" }
}, { timestamps: true });

const clickSchema = new mongoose.Schema({
  affiliate: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  ip: String,
  userAgent: String,
  createdAt: { type: Date, default: Date.now },
});

const payoutSchema = new mongoose.Schema({
  affiliate: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  amount: Number,
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending"
  },
  createdAt: { type: Date, default: Date.now },
  processedAt: Date,
});

const User = mongoose.model("User", userSchema);
const Click = mongoose.model("Click", clickSchema);
const PayoutRequest = mongoose.model("PayoutRequest", payoutSchema);

// --------- HELPERS ----------

function generateReferralCode(name, id) {
  const base = (name || "user").split(" ")[0].toLowerCase();
  return base + String(id).slice(-4) + Math.floor(100 + Math.random() * 900);
}

async function ensureAdminUser() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.log("Set ADMIN_EMAIL and ADMIN_PASSWORD in env.");
    return;
  }

  let admin = await User.findOne({ email, role: "admin" });
  if (!admin) {
    const passwordHash = await bcrypt.hash(password, 10);
    admin = await User.create({
      name: "Super Admin",
      email,
      passwordHash,
      referralCode: "admin",
      role: "admin",
    });
    console.log("Admin created:", email);
  } else {
    console.log("Admin already exists:", email);
  }
}

// --------- MIDDLEWARES ----------

async function loadSessionData(req, res, next) {
  res.locals.currentUser = null;
  res.locals.adminUser = null;

  if (req.session.userId) {
    res.locals.currentUser = await User.findById(req.session.userId);
  }
  if (req.session.adminId) {
    res.locals.adminUser = await User.findById(req.session.adminId);
  }

  next();
}

function requireAffiliate(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) {
    return res.redirect("/admin/login");
  }
  next();
}

app.use(loadSessionData);

// --------- GENERAL ROUTES ----------

app.get("/", (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");
  if (req.session.adminId) return res.redirect("/admin");
  res.redirect("/login");
});

// --------- AFFILIATE AUTH ----------

app.get("/register", (req, res) => {
  res.render("register", { error: null });
});

app.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.render("register", { error: "Sab field bhar do." });
  }

  try {
    const existing = await User.findOne({ email });
    if (existing) {
      return res.render("register", { error: "Ye email already registered hai." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let user = await User.create({
      name,
      email,
      passwordHash,
      referralCode: "temp",
      role: "affiliate",
    });

    user.referralCode = generateReferralCode(user.name, user._id);
    await user.save();

    req.session.userId = user._id.toString();
    res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    res.render("register", { error: "Error aaya." });
  }
});

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.render("login", { error: "Email aur password dalo." });
  }

  try {
    const user = await User.findOne({ email, role: "affiliate" });
    if (!user) {
      return res.render("login", { error: "Galat email ya password." });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.render("login", { error: "Galat email ya password." });
    }

    req.session.userId = user._id.toString();
    res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    res.render("login", { error: "Kuch galat ho gaya." });
  }
});

app.get("/logout", (req, res) => {
  req.session.userId = null;
  res.redirect("/login");
});

// --------- AFFILIATE DASHBOARD + PAYOUT ----------

app.get("/dashboard", requireAffiliate, async (req, res) => {
  const user = res.locals.currentUser;
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const referralLink = `${baseUrl}/r/${user.referralCode}`;

  const totalClicks = await Click.countDocuments({ affiliate: user._id });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayClicks = await Click.countDocuments({
    affiliate: user._id,
    createdAt: { $gte: todayStart },
  });

  const payouts = await PayoutRequest.find({ affiliate: user._id }).sort({ createdAt: -1 });

  res.render("dashboard", {
    referralLink,
    totalClicks,
    todayClicks,
    payouts,
  });
});

app.post("/payout-request", requireAffiliate, async (req, res) => {
  const { amount } = req.body;

  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    return res.redirect("/dashboard");
  }

  await PayoutRequest.create({
    affiliate: req.session.userId,
    amount: Number(amount),
    status: "pending",
  });

  res.redirect("/dashboard");
});

// --------- REFERRAL LINK CLICK TRACKING ----------

app.get("/r/:code", async (req, res) => {
  const { code } = req.params;
  const user = await User.findOne({ referralCode: code, role: "affiliate" });

  if (!user) {
    return res.status(404).send("Invalid referral link");
  }

  await Click.create({
    affiliate: user._id,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    userAgent: req.headers["user-agent"],
  });

  res.send(`You clicked referral of ${user.name}.`);
});

// --------- ADMIN AUTH ----------

app.get("/admin/login", (req, res) => {
  res.render("admin-login", { error: null });
});

app.post("/admin/login", async (req, res) => {
  const { email, password } = req.body;

  const admin = await User.findOne({ email, role: "admin" });
  if (!admin) return res.render("admin-login", { error: "Admin not found" });

  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) return res.render("admin-login", { error: "Wrong password" });

  req.session.adminId = admin._id.toString();
  res.redirect("/admin");
});

app.get("/admin/logout", (req, res) => {
  req.session.adminId = null;
  res.redirect("/admin/login");
});

// --------- ADMIN DASHBOARD ----------

app.get("/admin", requireAdmin, async (req, res) => {
  const totalAffiliates = await User.countDocuments({ role: "affiliate" });
  const totalClicks = await Click.countDocuments();
  const pendingPayouts = await PayoutRequest.countDocuments({ status: "pending" });

  res.render("admin-dashboard", {
    totalAffiliates,
    totalClicks,
    pendingPayouts,
  });
});

app.get("/admin/affiliates", requireAdmin, async (req, res) => {
  const affiliates = await User.find({ role: "affiliate" });
  res.render("admin-affiliates", { affiliates });
});

app.get("/admin/clicks", requireAdmin, async (req, res) => {
  const clicks = await Click.find().populate("affiliate").sort({ createdAt: -1 }).limit(100);
  res.render("admin-clicks", { clicks });
});

app.get("/admin/payouts", requireAdmin, async (req, res) => {
  const payouts = await PayoutRequest.find().populate("affiliate");
  res.render("admin-payouts", { payouts });
});

app.post("/admin/payouts/:id/approve", requireAdmin, async (req, res) => {
  await PayoutRequest.findByIdAndUpdate(req.params.id, {
    status: "approved",
    processedAt: new Date(),
  });
  res.redirect("/admin/payouts");
});

app.post("/admin/payouts/:id/reject", requireAdmin, async (req, res) => {
  await PayoutRequest.findByIdAndUpdate(req.params.id, {
    status: "rejected",
    processedAt: new Date(),
  });
  res.redirect("/admin/payouts");
});

// --------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
