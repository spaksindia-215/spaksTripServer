import crypto from "crypto";
import mongoose from "mongoose";
import { UserModel } from "../src/models/User.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 30)
    .replace(/^-+|-+$/g, "");
}

async function main() {
  const uri = process.env.MONGO_URI ?? process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI or MONGODB_URI not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB\n");

  const users = await UserModel.find({
    role: { $in: ["agent", "b2b_agent"] },
    $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }],
  }).select("name slug branding");

  if (users.length === 0) {
    console.log("All agents already have slugs. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Generating slugs for ${users.length} agent(s):\n`);
  console.log("Name".padEnd(30), "Phone".padEnd(15), "Generated slug");
  console.log("-".repeat(70));

  for (const user of users) {
    const base = slugify(user.branding?.companyName ?? user.name);
    const hex = crypto.randomBytes(3).toString("hex");
    const slug = `${base}-${hex}`;

    await UserModel.updateOne({ _id: user._id }, { $set: { slug } });

    const name = (user.name ?? "").slice(0, 28).padEnd(30);
    console.log(name, slug);
  }

  console.log("\nDone.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
