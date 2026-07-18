const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const admin = require('firebase-admin');

// 1. FIREBASE SECURE CONNECTION (WITH ERROR HANDLING)
try {
    if (!process.env.FIREBASE_CREDENTIALS) {
        console.error("🚨 FATAL ERROR: FIREBASE_CREDENTIALS environment variable is missing in Render!");
    } else {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin Connected Successfully!");
    }
} catch (err) {
    console.error("🚨 Firebase Init Error. Check your JSON formatting in Render Environment Variables:", err);
}

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

// 2. RAZORPAY CONNECTION
const razorpay = new Razorpay({
  key_id: 'rzp_live_TF0DKK9Rjy0EQU', 
  key_secret: process.env.RAZORPAY_SECRET 
});

// 3. MASTER SECURE API (CREATE ORDER)
app.post('/api/create-order', async (req, res) => {
  console.log("📦 NEW ORDER REQUEST RECEIVED:", JSON.stringify(req.body)); // Payload check

  try {
    const { cartItems, userEmail, pointsToUse } = req.body; 

    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
        console.log("❌ Error: Cart is empty or invalid format.");
        return res.status(400).json({ success: false, error: "Cart is empty" });
    }

    let calculatedTotal = 0;

   // STEP A: SERVER-SIDE PRICE VALIDATION
    for (let item of cartItems) {
        if (!item.id) {
            console.log("⚠️ Warning: Item missing ID in payload, skipping...");
            continue;
        }

        // 🚨 SECURITY FIX: BLOCK QUANTITY HACKS (NEGATIVE OR ZERO QTY) 🚨
        if (item.qty < 1 || isNaN(item.qty)) {
            console.log(`❌ Hacker alert: Invalid quantity ${item.qty} detected for product ${item.id}`);
            return res.status(400).json({ success: false, error: "Invalid product quantity detected." });
        }

        const productDoc = await db.collection('products').doc(item.id).get();
        
        if (!productDoc.exists) {
            console.log(`❌ Error: Product ID ${item.id} not found in database!`);
            continue; 
        }

        const productData = productDoc.data();
        let itemPrice = productData.price;

        if (item.selectedSize && productData.sizesData) {
            const sizeObj = productData.sizesData.find(s => s.size === item.selectedSize);
            if (sizeObj) {
                itemPrice = sizeObj.price;
            } else {
                console.log(`⚠️ Warning: Size ${item.selectedSize} not found for product ${item.id}. Using default price.`);
            }
        }
        calculatedTotal += (itemPrice * (item.qty || 1));
    }

    console.log(`💰 Calculated Base Total from DB: ₹${calculatedTotal}`);
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
                 console.log(`🎁 Discount Applied: -₹${discountRupees} (${actualPointsUsed} points)`);
            } else {
                 console.log("⚠️ Warning: User tried to use more points than they have.");
            }
        }
    }

    const finalPayableAmount = calculatedTotal - discountRupees;
    console.log(`💳 Final Payable Amount: ₹${finalPayableAmount}`);

    if (finalPayableAmount <= 0) {
         console.log("❌ Error: Final amount is zero or negative. Product might be missing in Firebase.");
         return res.status(400).json({ success: false, error: "Invalid Final Total. Product not found in database." });
    }

    // STEP C: CREATE ORDER
    const options = {
      amount: finalPayableAmount * 100, // Paise conversion
      currency: "INR",
      receipt: `rcpt_${Date.now().toString().slice(-8)}`
    };

    const order = await razorpay.orders.create(options);
    console.log("✅ Razorpay Order Created:", order.id);

    res.json({
      success: true,
      order_id: order.id,
      amount: options.amount,
      finalTotal: finalPayableAmount,
      pointsDeducted: actualPointsUsed
    });

  } catch (error) {
    console.error("🔥 Server Error during order creation:", error);
    res.status(500).json({ success: false, error: "Backend server failed to create order." });
  }
});

// --- 4. MARKETING PUSH NOTIFICATION API (FIXED FOR v12+) ---
app.post('/api/admin/send-offer', async (req, res) => {
    try {
        const { title, body, imageUrl } = req.body;

        if (!title || !body) {
            return res.status(400).json({ success: false, message: 'Title aur Body mandatory hai bhai.' });
        }

        const tokensSnapshot = await db.collection('fcm_tokens').get();
        const tokens = [];
        tokensSnapshot.forEach(doc => tokens.push(doc.id));

        if (tokens.length === 0) {
            return res.status(400).json({ success: false, message: 'Database mein koi token nahi hai.' });
        }

        // NAYA TARIKA: Message array banao
        const message = {
            notification: { title, body },
            tokens: tokens
        };
        
        // Agar image hai toh usse notification object mein daalo
        if (imageUrl) {
            message.notification.imageUrl = imageUrl;
        }

        // PURANE sendMulticast ki jagah sendEachForMulticast use karo
        const response = await admin.messaging().sendEachForMulticast(message);
        
        console.log(`✅ Push Sent! Success: ${response.successCount}, Failed: ${response.failureCount}`);
        res.json({ success: true, message: `Notification sent to ${response.successCount} users.` });

    } catch (error) {
        console.error('❌ Push Notification Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// YEH HAMESHA FILE KE SABSE AAKHIR MEIN RAHEGA
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Enterprise Server running securely on port ${PORT}`);
});
