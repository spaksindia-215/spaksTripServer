import mongoose from 'mongoose';
import { getMongoUri } from './mongoEnv.mjs';

const MONGO_URI = getMongoUri();

async function createAnother() {
  try {
    await mongoose.connect(MONGO_URI);

    const bookings = mongoose.connection.db.collection('bookings');
    const users = mongoose.connection.db.collection('users');
    
    const user = await users.findOne({ email: 'customer@spakstrip.dev' });
    
    const checkInDate = new Date();
    checkInDate.setDate(checkInDate.getDate() + 3);
    const checkOutDate = new Date(checkInDate);
    checkOutDate.setDate(checkOutDate.getDate() + 1);

    const result = await bookings.insertOne({
      ownerId: user._id,
      ownerRole: 'customer',
      productType: 'hotel',
      status: 'active',
      pnr: 'TEST' + Date.now(),
      amount: 8500,
      currency: 'INR',
      details: {
        hotelName: 'Test Hotel 2',
        city: 'Delhi',
        checkIn: checkInDate.toISOString().split('T')[0],
        checkOut: checkOutDate.toISOString().split('T')[0],
        guests: 2,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log('✅ Created test booking:');
    console.log(`   ID: ${result.insertedId}`);
    console.log('   User: customer@spakstrip.dev');
    console.log('   Hotel: Test Hotel 2');
    console.log('   Amount: ₹8500');

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

createAnother();
