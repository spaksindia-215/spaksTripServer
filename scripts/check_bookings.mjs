import mongoose from 'mongoose';
import { getMongoUri } from './mongoEnv.mjs';

const MONGO_URI = getMongoUri();

async function checkBookings() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB\n');

    const db = mongoose.connection.db;

    // Check all bookings collection
    const bookings = db.collection('bookings');
    const allBookings = await bookings.find({}).toArray();

    console.log(`Total bookings in collection: ${allBookings.length}\n`);

    if (allBookings.length > 0) {
      console.log('Recent bookings:');
      allBookings.slice(-5).forEach((b, i) => {
        console.log(`\n${i + 1}. ID: ${b._id}`);
        console.log(`   Owner: ${b.ownerId}`);
        console.log(`   Role: ${b.ownerRole}`);
        console.log(`   Product: ${b.productType}`);
        console.log(`   Status: ${b.status}`);
        console.log(`   PNR: ${b.pnr}`);
        console.log(`   Amount: ${b.amount}`);
        console.log(`   Created: ${b.createdAt}`);
      });
    }

    // Check hotel payment records
    console.log('\n\n--- Hotel Payment Records ---');
    const payments = db.collection('hotel_payment_records');
    const allPayments = await payments.find({}).toArray();

    console.log(`Total hotel payment records: ${allPayments.length}\n`);

    if (allPayments.length > 0) {
      console.log('Recent payments:');
      allPayments.slice(-3).forEach((p, i) => {
        console.log(`\n${i + 1}. Payment ID: ${p.razorpayPaymentId}`);
        console.log(`   Order ID: ${p.razorpayOrderId}`);
        console.log(`   Status: ${p.status}`);
        console.log(`   TBO Booking ID: ${p.tboBookingId}`);
        console.log(`   TBO Booking Ref: ${p.tboBookingRefNo}`);
        console.log(`   Amount: ${p.netAmount}`);
        console.log(`   Created: ${p.createdAt}`);
      });
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkBookings();
