const xss = require('xss');
const crypto = require('crypto');
const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const admin = require('firebase-admin');

// 1. FIREBASE SECURE CONNECTION
try {
    let serviceAccount;
    
    if (process.env.FIREBASE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        console.log("🟢 Loaded Firebase credentials from Environment Variable.");
    } else {
        serviceAccount = require('./serviceAccountKey.json');
        console.log("🟡 Loaded Firebase credentials from local serviceAccountKey.json file.");
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    
    console.log("✅ Firebase Admin Connected Successfully!");
} catch (err) {
    console.error("🚨 Firebase Init Error:", err);
}

const db = admin.firestore();
const app = express();

// ==========================================
// --- SECURITY & MIDDLEWARE CONFIGURATION ---
// ==========================================

// HELMET (Basic security headers setup)
const helmet = require('helmet');
app.use(helmet());

// CORS (Cross-origin rules)
app.use(cors({
    origin: ['https://desidealshub.com', 'http://localhost:3000'],
    methods: ['GET', 'POST']
}));

// 🚨 PAYLOAD LIMITER (Replaced plain express.json() to prevent DoS attacks) 🚨
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ANTI-DDOS / SPAM GUARD (Rate Limiter)
const rateLimit = require('express-rate-limit');

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
        return res.status(401).json({ success: false, error: "Token missing. Chal nikal!" });
    }

    const token = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        const ADMIN_EMAIL = 'shishirk0401@gmail.com'; 

        if (decodedToken.email !== ADMIN_EMAIL) {
            return res.status(403).json({ success: false, error: "Aukat se bahar! You are not the admin." });
        }

        req.user = decodedToken; 
        next();
    } catch (error) {
        return res.status(401).json({ success: false, error: "Invalid or expired admin token." });
    }
};

// 🚨 USER VERIFICATION MIDDLEWARE (THE GUEST CHECKOUT FIX) 🚨
const verifyUser = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.user = null; 
        return next();
    }

    const token = authHeader.split('Bearer ')[1];

    // YAHAN HAI GUEST KA BYPASS FIX
    if (token === "GUEST") {
        console.log("👤 Guest user checkout initiated.");
        req.user = null; 
        return next();
    }

    try {
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
  console.log("📦 NEW ORDER REQUEST RECEIVED"); 

  try {
    const { cartItems, pointsToUse } = req.body;
    const userEmail = req.user ? req.user.email : 'guest'; // Guest aayega yahan ab easily

    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
        return res.status(400).json({ success: false, error: "Cart is empty" });
    }

    let calculatedTotal = 0;

    for (let item of cartItems) {
        if (!item.id) continue;

        if (item.qty < 1 || isNaN(item.qty)) {
            return res.status(400).json({ success: false, error: "Invalid product quantity detected." });
        }

        const productDoc = await db.collection('products').doc(item.id).get();
        if (!productDoc.exists) continue; 

        const productData = productDoc.data();
        let itemPrice = productData.price;

        if (item.selectedSize && productData.sizesData) {
            const sizeObj = productData.sizesData.find(s => s.size === item.selectedSize);
            if (sizeObj) {
                itemPrice = sizeObj.price;
            }
        }
        calculatedTotal += (itemPrice * (item.qty || 1));
    }
    
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
         return res.status(400).json({ success: false, error: "Invalid Final Total." });
    }

    const options = {
      amount: finalPayableAmount * 100, 
      currency: "INR",
      receipt: `rcpt_${Date.now().toString().slice(-8)}`
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
    console.error("🔥 ACTUAL SYSTEM ERROR:", error);
    res.status(500).json({ success: false, error: "Internal Server Error." });
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
            
            // 🇮🇳 DONATION TRACKER
            try {
                await db.collection('public_stats').doc('donation_tracker').update({
                    totalOrders: admin.firestore.FieldValue.increment(1),
                    raisedAmount: admin.firestore.FieldValue.increment(10)
                });
                console.log("✅ [Donation Tracker]: ₹10 Added from Online Payment.");
            } catch (trackerErr) {
                console.error("⚠️ [Donation Tracker Error]:", trackerErr);
            }

            return res.status(200).json({ success: true, message: "Payment verified successfully" });
        } else {
            return res.status(400).json({ success: false, message: "Invalid signature! Hacker detected." });
        }
    } catch (error) {
        console.error("🔥 ACTUAL SYSTEM ERROR:", error);
        res.status(500).json({ success: false, error: "Internal Server Error." }); 
    }
});

// 🚀 MARKETING PUSH NOTIFICATION API
app.post('/api/admin/send-offer', verifyAdmin, async (req, res) => {
    try {
        const { title, body, imageUrl } = req.body;

        if (!title || !body) {
            return res.status(400).json({ success: false, message: 'Title aur Body mandatory hai bhai.' });
        }

        const tokensSnapshot = await db.collection('fcm_tokens').get();
        const allTokens = [];
        tokensSnapshot.forEach(doc => allTokens.push(doc.id));

        if (allTokens.length === 0) {
            return res.status(400).json({ success: false, message: 'Database mein koi token nahi hai.' });
        }

        let totalSuccess = 0;
        let totalFailed = 0;
        const tokensToRemove = [];

        const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
        const tokenChunks = chunkArray(allTokens, 500);

        for (const chunk of tokenChunks) {
            const message = { notification: { title, body }, tokens: chunk };
            if (imageUrl) message.notification.image = imageUrl;

            const response = await admin.messaging().sendEachForMulticast(message);
            totalSuccess += response.successCount;
            totalFailed += response.failureCount;

            if (response.failureCount > 0) {
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        const errorCode = resp.error.code;
                        if (errorCode === 'messaging/invalid-registration-token' ||
                            errorCode === 'messaging/registration-token-not-registered') {
                            tokensToRemove.push(chunk[idx]);
                        }
                    }
                });
            }
        }

        if (tokensToRemove.length > 0) {
            const batch = db.batch();
            tokensToRemove.forEach(token => {
                batch.delete(db.collection('fcm_tokens').doc(token));
            });
            await batch.commit(); 
        }

        res.json({ success: true, message: `Notification sent to ${totalSuccess} users.` });

    } catch (error) {
        res.status(500).json({ success: false, error: "Internal Server Error." });
    }
});

// INDIVIDUAL PUSH NOTIFICATION (ORDER TRACKING)
app.post('/api/admin/update-tracking', verifyAdmin, async (req, res) => {
    try {
        const { orderId, trackingUrl } = req.body;
        
        if (!orderId || !trackingUrl) {
            return res.status(400).json({ success: false, message: 'Order ID aur Tracking URL dono zaruri hain!' });
        }

        const orderDoc = await db.collection('orders').doc(orderId).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, message: 'Order ID database mein nahi mili.' });
        }
        
        const orderData = orderDoc.data();
        const targetEmail = orderData.userAccount;
        const targetPhone = orderData.customerPhone; 

        await db.collection('orders').doc(orderId).update({
            trackingUrl: trackingUrl,
            status: 'Dispatched'
        });

        const targetId = (targetEmail && targetEmail !== 'Guest' && targetEmail !== 'guest') ? targetEmail : targetPhone;

        if (targetId) {
            const tokensSnapshot = await db.collection('fcm_tokens').where('user', '==', targetId).get();
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
                
                const response = await admin.messaging().sendEachForMulticast(message);
                
                const tokensToRemove = [];
                if (response.failureCount > 0) {
                    response.responses.forEach((resp, idx) => {
                        if (!resp.success && (resp.error.code === 'messaging/invalid-registration-token' || resp.error.code === 'messaging/registration-token-not-registered')) {
                            tokensToRemove.push(tokens[idx]);
                        }
                    });
                    if (tokensToRemove.length > 0) {
                        const batch = db.batch();
                        tokensToRemove.forEach(token => batch.delete(db.collection('fcm_tokens').doc(token)));
                        await batch.commit();
                    }
                }
            }
        }
        
        res.json({ success: true, message: "Order updated & Notification check complete!" });
    } catch (error) {
        res.status(500).json({ success: false, error: "Server Error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Enterprise Server running securely on port ${PORT}`);
});
