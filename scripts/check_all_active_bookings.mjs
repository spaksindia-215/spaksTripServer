import mongoose from 'mongoose';
import { getMongoUri } from './mongoEnv.mjs';

const MONGO_URI = getMongoUri();

async function checkAllBookings() {
  try {
    await mongoose.connect(MONGO_URI);

    const db = mongoose.connection.db;
    const bookings = db.collection('bookings');
    const users = db.collection('users');

    // Get all active bookings
    const activeBookings = await bookings.find({ status: 'active' }).toArray();

    console.log(`Total ACTIVE bookings: ${activeBookings.length}\n`);

    for (const booking of activeBookings) {
      const user = await users.findOne({ _id: booking.ownerId });
      console.log(`📌 ${booking.productType.toUpperCase()} - ${booking.pnr}`);
      console.log(`   User: ${user?.email || 'Unknown'}`);
      console.log(`   Amount: ₹${booking.amount}`);
      console.log(`   Created: ${new Date(booking.createdAt).toLocaleString('en-IN')}`);
      console.log('');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkAllBookings();
