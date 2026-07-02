import mongoose from 'mongoose';
import { getMongoUri } from './mongoEnv.mjs';

const MONGO_URI = getMongoUri();

async function checkUserBookings() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB\n');

    const db = mongoose.connection.db;

    // Get the test customer
    const users = db.collection('users');
    const customer = await users.findOne({ email: 'customer@spakstrip.dev' });

    if (!customer) {
      console.log('❌ Customer not found');
      process.exit(1);
    }

    console.log(`✅ Found customer: ${customer.email}`);
    console.log(`   ID: ${customer._id}\n`);

    // Get bookings for this customer
    const bookings = db.collection('bookings');
    const userBookings = await bookings.find({ ownerId: customer._id }).toArray();

    console.log(`📌 Bookings for this customer: ${userBookings.length}\n`);

    userBookings.forEach((b, i) => {
      console.log(`${i + 1}. ${b.productType.toUpperCase()}`);
      console.log(`   Status: ${b.status}`);
      console.log(`   Amount: ₹${b.amount}`);
      console.log(`   PNR: ${b.pnr}`);
      console.log(`   Created: ${new Date(b.createdAt).toLocaleString('en-IN')}`);
      console.log('');
    });

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkUserBookings();
