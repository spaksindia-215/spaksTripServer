// Seeds one dev account per role with known credentials. Idempotent — upserts
// by phone, so re-running just resets the accounts (password included).
//
// Run from server/:  npm run seed:dev
// (needs MONGO_URI in .env and Node >= 20.9)
//
// NOTE: this inserts directly via the model and bypasses the registration
// validators, so it is for local/dev use only.

import bcrypt from "bcrypt";
import mongoose from "mongoose";
import { connectDb } from "../src/config/db";
import { UserModel, type Role, type UserStatus } from "../src/models/User";

const PASSWORD = "Test@1234";
const BCRYPT_ROUNDS = 12;

type SeedUser = {
  role: Role;
  name: string;
  phone: string;
  email: string;
  status: UserStatus;
  aadhar: string;
  gst?: string;
  pan?: string;
  creditLimit?: number;
};

const USERS: SeedUser[] = [
  {
    role: "customer",
    name: "Dev Customer",
    phone: "9000000001",
    email: "customer@spakstrip.dev",
    status: "active",
    aadhar: "123412341234",
  },
  {
    role: "agent",
    name: "Dev Agent",
    phone: "9000000002",
    email: "agent@spakstrip.dev",
    status: "active",
    aadhar: "123412341234",
    creditLimit: 50000,
  },
  {
    role: "b2b_agent",
    name: "Dev B2B Agent",
    phone: "9000000003",
    email: "b2b@spakstrip.dev",
    status: "active",
    aadhar: "123412341234",
    gst: "22AAAAA0000A1Z5",
    pan: "ABCDE1234F",
    creditLimit: 100000,
  },
  {
    role: "partner",
    name: "Dev Partner",
    phone: "9000000004",
    email: "partner@spakstrip.dev",
    status: "active",
    aadhar: "123412341234",
    gst: "27BBBBB1111B1Z6",
    pan: "FGHIJ5678K",
  },
];

async function main(): Promise<void> {
  await connectDb();
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);

  for (const u of USERS) {
    await UserModel.findOneAndUpdate(
      { phone: u.phone },
      {
        $set: {
          name: u.name,
          phone: u.phone,
          email: u.email,
          passwordHash,
          role: u.role,
          status: u.status,
          aadhar: u.aadhar,
          gst: u.gst,
          pan: u.pan,
          creditLimit: u.creditLimit ?? null,
          walletBalance: 0,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  console.log("\n  Seeded dev accounts (password for all: " + PASSWORD + ")\n");
  console.log("  Role        Phone (login)   Email");
  console.log("  ──────────  ──────────────  ─────────────────────────");
  for (const u of USERS) {
    console.log(`  ${u.role.padEnd(10)}  ${u.phone.padEnd(14)}  ${u.email}`);
  }
  console.log(
    "\n  Superadmin: no account — visit /superadmin and use the SUPERADMIN_PASSWORD env value.\n",
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
