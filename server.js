const xss = require('xss');
const crypto = require('crypto');
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

app.use(cors({
    origin: ['https://desidealshub.com', 'http://localhost:3000'], // Tera actual domain
    methods: ['GET', 'POST']
}));
app.use(express.json());

const rateLimit = require('express-rate-limit');

// 🚨 ANTI-DDOS / SPAM GUARD
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 50, 
    message: { 
        success: false, 
        error: "Aram se bhai! Bahut zyada requests aagayi hain. 15 minute baad try kar." 
    },
    standardHeaders: true, 
    legacyHeaders: false, 
});

app.use('/api/', apiLimiter);

// 2. RAZORPAY CONNECTION
const razorpay = new Razorpay({
  key_id: 'rzp_live_TF0DKK9Rjy0EQU', 
  key_secret: process.env.RAZORPAY_SECRET 
});

// ADMIN VERIFICATION MIDDLEWARE
const verifyAdmin = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log("🚨 Unauthorized access attempt!");
        return res.status(401).json({ success: false, error: "Token missing. Chal nikal!" });
    }

    const token = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        
        const ADMIN_EMAIL = 'shishirk0401@gmail.com'; 

        if (decodedToken.email !== ADMIN_EMAIL) {
            console.log(`🚨 Fake Admin alert: ${decodedToken.email} tried to send notification!`);
            return res.status(403).json({ success: false, error: "Aukat se bahar! You are not the admin." });
        }

        req.user = decodedToken; 
        next();
    } catch (error) {
        console.error("🚨 Token Verification Failed:", error.message);
        return res.status(401).json({ success: false, error: "Invalid or expired token." });
    }
};

// USER VERIFICATION MIDDLEWARE (For Orders)
const verifyUser = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.user = null; 
        return next();
    }

    try {
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken; 
        next();
    } catch (error) {
        console.error("🚨 User Token Verification Failed:", error.message);
        return res.status(401).json({ success: false, error: "Invalid login session. Please login again." });
    }
};

// 3. MASTER SECURE API (CREATE ORDER)
app.post('/api/create-order', verifyUser, async (req, res) => {
  console.log("📦 NEW ORDER REQUEST RECEIVED:", JSON.stringify(req.body)); 

  try {
    const { cartItems, pointsToUse } = req.body;
    
    // 🚨 ANTI-SPOOFING FIX: Token se email nikalo
    const userEmail = req.user ? req.user.email : 'guest'; 

    // 🚨 XSS SANITIZATION FOR FUTURE FIELDS 🚨
    // Jab frontend se shipping info aayegi, ye variables saaf data hold karenge
    const cleanName = req.body.name ? xss(req.body.name) : 'Not Provided';
    const cleanAddress = req.body.address ? xss(req.body.address) : 'Not Provided';
    const cleanPhone = req.body.phone ? xss(req.body.phone) : 'Not Provided';
    const cleanNotes = req.body.notes ? xss(req.body.notes) : '';

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

        // 🚨 SECURITY FIX: BLOCK QUANTITY HACKS
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
         console.log("❌ Error: Final amount is zero or negative.");
         return res.status(400).json({ success: false, error: "Invalid Final Total. Product not found in database." });
    }

    // STEP C: CREATE ORDER
    const options = {
      amount: finalPayableAmount * 100, 
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
    console.error("🔥 ACTUAL SYSTEM ERROR:", error);
    res.status(500).json({ success: false, error: "Internal Server Error. Please try again later." });
  }
});

// RAZORPAY PAYMENT VERIFICATION API
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        const sign = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSign = crypto
            .createHmac("sha256", process.env.RAZORPAY_SECRET)
            .update(sign.toString())
            .digest("hex");

        if (razorpay_signature === expectedSign) {
            console.log("✅ Payment Verified for Order:", razorpay_order_id);
            return res.status(200).json({ success: true, message: "Payment verified successfully" });
        } else {
            console.log("🚨 FAKE PAYMENT DETECTED! Signature mismatch.");
            return res.status(400).json({ success: false, message: "Invalid signature! Hacker detected." });
        }
    } catch (error) {
        console.error("🔥 ACTUAL SYSTEM ERROR:", error);
        res.status(500).json({ success: false, error: "Internal Server Error. Please try again later." }); 
    }
});

// --- 4. MARKETING PUSH NOTIFICATION API ---
app.post('/api/admin/send-offer', verifyAdmin, async (req, res) => {
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

        const message = {
            notification: { title, body },
            tokens: tokens
        };
        
        if (imageUrl) {
            message.notification.image = imageUrl;
        }

        const response = await admin.messaging().sendEachForMulticast(message);
        
        console.log(`✅ Push Sent! Success: ${response.successCount}, Failed: ${response.failureCount}`);
        res.json({ success: true, message: `Notification sent to ${response.successCount} users.` });

    } catch (error) {
        console.error('🔥 ACTUAL SYSTEM ERROR:', error);
        // YAHAN LEAKAGE HO RAHA THA JO FIX KAR DIYA HAI
        res.status(500).json({ success: false, error: "Internal Server Error. Please try again later." });
    }
});
// --- 5. INDIVIDUAL PUSH NOTIFICATION (ORDER TRACKING) ---
app.post('/api/admin/update-tracking', verifyAdmin, async (req, res) => {
    try {
        const { orderId, trackingUrl } = req.body;
        
        if (!orderId || !trackingUrl) {
            return res.status(400).json({ success: false, message: 'Order ID aur Tracking URL dono zaruri hain!' });
        }

        // 1. Order fetch kar
        const orderDoc = await db.collection('orders').doc(orderId).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, message: 'Order ID database mein nahi mili.' });
        }
        
        const orderData = orderDoc.data();
        const targetEmail = orderData.userAccount;

        // 2. Order status update kar
        await db.collection('orders').doc(orderId).update({
            trackingUrl: trackingUrl,
            status: 'Dispatched'
        });

        // 3. Notification bhejo (agar user logged in hai)
        if (targetEmail && targetEmail !== 'Guest' && targetEmail !== 'guest') {
            const tokensSnapshot = await db.collection('fcm_tokens').where('user', '==', targetEmail).get();
            const tokens = [];
            tokensSnapshot.forEach(doc => tokens.push(doc.id));

            if (tokens.length > 0) {
                const message = {
                    notification: {
                        title: "📦 Order Dispatched!",
                        body: "Aapka order nikal chuka hai. Track karne ke liye tap karein."
                    },
                    tokens: tokens
                };
                await admin.messaging().sendEachForMulticast(message);
            }
        }
        
        res.json({ success: true, message: "Order updated & Notification sent!" });
    } catch (error) {
        console.error('🔥 Error:', error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
});

// YEH HAMESHA FILE KE SABSE AAKHIR MEIN RAHEGA
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Enterprise Server running securely on port ${PORT}`);
});
