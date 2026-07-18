const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const admin = require('firebase-admin');

// 1. FIREBASE SECURE CONNECTION
if (!process.env.FIREBASE_CREDENTIALS) {
    console.error("FATAL ERROR: FIREBASE_CREDENTIALS is missing in Render!");
} else {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// 2. RAZORPAY CONNECTION
const razorpay = new Razorpay({
  key_id: 'rzp_live_TEsQZjmlsRn0VZ', 
  key_secret: process.env.RAZORPAY_SECRET 
});

// 3. MASTER SECURE API
app.post('/api/create-order', async (req, res) => {
  try {
    const { cartItems, userEmail, pointsToUse } = req.body; 

    if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ success: false, error: "Cart is empty" });
    }

    let calculatedTotal = 0;

    // STEP A: SERVER-SIDE PRICE VALIDATION
    for (let item of cartItems) {
        const productDoc = await db.collection('products').doc(item.id).get();
        if (!productDoc.exists) continue; 

        const productData = productDoc.data();
        let itemPrice = productData.price;

        if (item.selectedSize && productData.sizesData) {
            const sizeObj = productData.sizesData.find(s => s.size === item.selectedSize);
            if (sizeObj) itemPrice = sizeObj.price;
        }
        calculatedTotal += (itemPrice * item.qty);
    }

    // STEP B: POINTS VALIDATION
    let discountRupees = 0;
    let actualPointsUsed = 0;

    if (pointsToUse > 0 && userEmail && userEmail !== 'guest') {
        const userDoc = await db.collection('users').doc(userEmail).get();
        if (userDoc.exists) {
            const userPoints = userDoc.data().points || 0;
            const maxDiscountAllowed = Math.floor(calculatedTotal * 0.15); 
            const maxPointsAllowed = maxDiscountAllowed * 50; 

            if (userPoints >= pointsToUse) {
                 actualPointsUsed = Math.min(pointsToUse, maxPointsAllowed);
                 discountRupees = Math.floor(actualPointsUsed * 0.02);
            }
        }
    }

    const finalPayableAmount = calculatedTotal - discountRupees;

    if (finalPayableAmount <= 0) {
         return res.status(400).json({ success: false, error: "Invalid Final Total" });
    }

    // STEP C: CREATE ORDER
    const options = {
      amount: finalPayableAmount * 100, 
      currency: "INR",
      receipt: `receipt_${Date.now()}`
    };

    const order = await razorpay.orders.create(options);

    res.json({
      success: true,
      order_id: order.id,
      amount: options.amount,
      finalTotal: finalPayableAmount,
      pointsDeducted: actualPointsUsed
    });

  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ success: false, error: "Backend server failed to create order." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Enterprise Server running on port ${PORT}`);
});
