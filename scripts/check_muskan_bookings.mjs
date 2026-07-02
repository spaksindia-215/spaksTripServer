import mongoose from 'mongoose';
import { getMongoUri } from './mongoEnv.mjs';

const MONGO_URI = getMongoUri();

async function checkMuskanBookings() {
  try {
    await mongoose.connect(MONGO_URI);

    const db = mongoose.connection.db;
    const users = db.collection('users');
    const bookings = db.collection('bookings');
    const payments = db.collection('hotel_payment_records');

    // Find the user
    const user = await users.findOne({ email: 'muskan987654kumari@gmail.com' });

    if (!user) {
      console.log('❌ User not found');
      process.exit(1);
    }

    console.log(`✅ Found user: ${user.email}`);
    console.log(`   ID: ${user._id}\n`);

    // Check bookings
    const userBookings = await bookings.find({ ownerId: user._id }).toArray();
    console.log(`📌 Bookings: ${userBookings.length}`);
    userBookings.forEach((b) => {
      console.log(`   - ${b.productType}: ₹${b.amount} (${b.status}) - PNR: ${b.pnr}`);
    });

    // Check payment records
    console.log(`\n🔍 Hotel Payment Records:`);
    const allPayments = await payments.find({}).toArray();
    console.log(`   Total in DB: ${allPayments.length}`);
    
    if (allPayments.length > 0) {
      console.log('\n   Recent payments:');
      allPayments.slice(-5).forEach((p) => {
        console.log(`   - Status: ${p.status}, TBO ID: ${p.tboBookingId}, Amount: ₹${p.netAmount}`);
      });
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkMuskanBookings();
