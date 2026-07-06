import mongoose from 'mongoose';
import { getMongoUri } from './mongoEnv.mjs';

// MongoDB connection string
const MONGO_URI = getMongoUri();

// Booking Schema
const bookingSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  ownerRole: { type: String, enum: ['customer', 'agent', 'b2b_agent', 'partner'], required: true },
  partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  productType: { type: String, enum: ['flight', 'hotel', 'taxi', 'tour', 'cruise', 'package'], required: true },
  status: { type: String, enum: ['active', 'held', 'cancelled', 'completed'], required: true, default: 'active' },
  pnr: { type: String, trim: true },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'INR', trim: true },
  holdExpiresAt: { type: Date },
  cancelRequestedAt: { type: Date },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  tboFare: { type: Number, min: 0 },
  platformMarkup: { type: Number, min: 0 },
  netFare: { type: Number, min: 0 },
  agentMarkup: { type: Number, min: 0 },
  customerPaid: { type: Number, min: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const Booking = mongoose.model('Booking', bookingSchema);

async function createTestBooking() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    // Find a customer user (or use a known ID)
    const User = mongoose.model('User');
    const user = await User.findOne({ role: 'customer' });

    if (!user) {
      console.error('No customer found in database');
      process.exit(1);
    }

    console.log(`Found user: ${user.name} (${user._id})`);

    // Create a test hotel booking
    const testBooking = new Booking({
      ownerId: user._id,
      ownerRole: 'customer',
      productType: 'hotel',
      status: 'active',
      pnr: 'TBO' + Date.now(),
      amount: 12500,
      currency: 'INR',
      details: {
        hotelName: 'Test Hotel Mumbai',
        checkIn: new Date().toISOString().split('T')[0],
        checkOut: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        rooms: 1,
        nights: 2,
      },
    });

    const savedBooking = await testBooking.save();
    console.log('✅ Test booking created successfully!');
    console.log(`   Booking ID: ${savedBooking._id}`);
    console.log(`   PNR: ${savedBooking.pnr}`);
    console.log(`   Amount: ₹${savedBooking.amount}`);
    console.log('\n📌 You should now see this booking in /customer/dashboard with a "Request cancellation" button');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating test booking:', error.message);
    process.exit(1);
  }
}

createTestBooking();
