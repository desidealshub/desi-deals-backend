const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// YAHAN TERA SECRET KEY AAYEGA 
const razorpay = new Razorpay({
  key_id: 'rzp_live_TEsQZjmlsRn0VZ', 
  key_secret: 'p82y4q6S6i7t0VOecUqmPfqa' // Apna asli secret yahan daal
});

app.post('/api/create-order', async (req, res) => {
  try {
    const { amount } = req.body; 

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const options = {
      amount: amount * 100, 
      currency: "INR",
      receipt: `receipt_${Date.now()}`
    };

    const order = await razorpay.orders.create(options);
    
    res.json({
      success: true,
      order_id: order.id,
      amount: options.amount
    });

  } catch (error) {
    console.error("Razorpay Error:", error);
    res.status(500).json({ success: false, error: "Order create nahi hua" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Secure server running on port ${PORT}`);
});
