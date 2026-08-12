const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, getApps, getApp } = require('firebase/app');
const {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  increment,
  serverTimestamp,
  runTransaction
} = require('firebase/firestore');

// ============================================================================
// FIREBASE CLIENT SDK INITIALIZATION
// ============================================================================
const firebaseConfig = {
  apiKey: "AIzaSyA31mxhzP9wCSiGF9UEc3hNtun5_7sjzNA",
  authDomain: "rox-task-bot-73fbe.firebaseapp.com",
  projectId: "rox-task-bot-73fbe",
  storageBucket: "rox-task-bot-73fbe.firebasestorage.app",
  messagingSenderId: "544132881063",
  appId: "1:544132881063:web:7145408b544255e8a95982"
};

// Initialize or reuse existing Firebase app instance
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

// Initialize Telegram Bot Instance (Webhook Mode - No polling)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8828665504:AAG91pucgoXefAy_2Pbj_SC6NzH2_k_VQ1s";
const bot = TELEGRAM_BOT_TOKEN ? new TelegramBot(TELEGRAM_BOT_TOKEN) : null;

// ============================================================================
// REQUIRED BACKEND FUNCTIONS
// ============================================================================

/**
 * Creates or updates a user document in Firestore and sets frontendOpened = true
 */
async function createOrEnsureUser(userId, firstName, photoURL, referralId) {
  const uId = String(userId);
  const userRef = doc(db, "users", uId);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists()) {
    const newUser = {
      id: uId,
      name: firstName || "User",
      photoURL: photoURL || "",
      coins: 0,
      reffer: 0,
      refferBy: (referralId && String(referralId) !== uId) ? String(referralId) : null,
      tasksCompleted: 0,
      totalWithdrawals: 0,
      frontendOpened: true,
      rewardGiven: false
    };
    await setDoc(userRef, newUser);
    return newUser;
  } else {
    // Merge/Ensure frontendOpened is set to true within the same request
    await updateDoc(userRef, {
      frontendOpened: true
    });
    return { ...userSnap.data(), frontendOpened: true };
  }
}

/**
 * Atomically processes referral rewards using a Firestore transaction
 * Ensures idempotency: reward is granted ONCE only if all conditions pass
 */
async function processReferralReward(userId) {
  const uId = String(userId);

  await runTransaction(db, async (transaction) => {
    const userRef = doc(db, "users", uId);
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists()) return;

    const userData = userSnap.data();

    // Strict Referral Conditions
    if (
      userData.frontendOpened === true &&
      userData.rewardGiven === false &&
      userData.refferBy !== null &&
      String(userData.refferBy) !== uId
    ) {
      const referrerId = String(userData.refferBy);
      const referrerRef = doc(db, "users", referrerId);
      const referrerSnap = await transaction.get(referrerRef);

      if (referrerSnap.exists()) {
        // 1. Increment Referrer coins (+500) and referral count (+1)
        transaction.update(referrerRef, {
          coins: increment(500),
          reffer: increment(1)
        });

        // 2. Mark current user as rewardGiven = true
        transaction.update(userRef, {
          rewardGiven: true
        });

        // 3. Create ledger entry in ref_rewards
        const rewardRef = doc(db, "ref_rewards", uId);
        transaction.set(rewardRef, {
          userId: uId,
          referrerId: referrerId,
          reward: 500,
          createdAt: serverTimestamp()
        });
      }
    }
  });
}

/**
 * Helper function to update a single user field in Firestore
 */
async function updateField(userId, field, value) {
  const userRef = doc(db, "users", String(userId));
  await updateDoc(userRef, {
    [field]: value
  });
}

/**
 * Helper function to increment a numeric field in Firestore
 */
async function incrementField(userId, field, amount) {
  const userRef = doc(db, "users", String(userId));
  await updateDoc(userRef, {
    [field]: increment(amount)
  });
}

// ============================================================================
// VERCEL SERVERLESS WEBHOOK HANDLER
// ============================================================================

module.exports = async (req, res) => {
  // Only handle POST requests from Telegram Webhooks
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'ok', message: 'Telegram Bot Webhook Endpoint' });
  }

  try {
    const update = req.body;

    // Validate webhook message presence
    if (!update || !update.message) {
      return res.status(200).json({ status: 'ignored' });
    }

    const msg = update.message;
    const chatId = msg.chat.id;
    const from = msg.from;

    if (!from) {
      return res.status(200).json({ status: 'no_user_info' });
    }

    const userId = String(from.id);
    const firstName = from.first_name || 'User';
    const text = msg.text || '';

    // Safely attempt user photo URL retrieval
    let photoURL = '';
    try {
      if (bot) {
        const userPhotos = await bot.getUserProfilePhotos(from.id, { limit: 1 });
        if (userPhotos && userPhotos.total_count > 0 && userPhotos.photos[0].length > 0) {
          const fileId = userPhotos.photos[0][0].file_id;
          const file = await bot.getFile(fileId);
          photoURL = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        }
      }
    } catch (photoErr) {
      photoURL = ''; // Fallback if profile photo retrieval fails
    }

    // Process /start command
    if (text.startsWith('/start')) {
      // Extract referral ID parameter (/start ref123 OR /start 123)
      let referralId = null;
      const parts = text.split(' ');
      if (parts.length > 1) {
        const rawParam = parts[1].trim();
        referralId = rawParam.replace(/^ref/i, '');
      }

      // 1. Create or ensure Firestore user doc (sets frontendOpened = true)
      await createOrEnsureUser(userId, firstName, photoURL, referralId);

      // 2. Run referral reward logic immediately in the same request
      await processReferralReward(userId);

      // 3. Send Telegram Welcome Response
      if (bot) {
        const imageUrl = 'https://ibb.co/MkLPpdLT';
        const caption = `👋 Hi! Welcome ${firstName} ⭐\nYaha aap tasks complete karke real rewards kama sakte ho!\n\n🔥 Daily Tasks\n🔥 Video Watch\n🔥 Mini Apps\n🔥 Referral Bonus\n🔥 Auto Wallet System\n\nReady to earn?\nTap START and your journey begins!`;

        const replyOptions = {
          caption: caption,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "▶ Open App",
                  web_app: { url: "https://ramgopal07.github.io/Rox-Task-Bot/Telegram-bot-web" }
                }
              ],
              [
                { text: "📢 Channel", url: "https://t.me/rghackzone" },
                { text: "🌐 Community", url: "https://t.me/rghackzone07" }
              ]
            ]
          }
        };

        try {
          await bot.sendPhoto(chatId, imageUrl, replyOptions);
        } catch (sendPhotoErr) {
          // Fallback to text message if photo URL cannot be fetched directly by Telegram
          await bot.sendMessage(chatId, caption, replyOptions);
        }
      }
    }

    // Return 200 HTTP response to complete function execution
    return res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error("Webhook Execution Error:", error);
    // Respond 200 to prevent Telegram from endlessly retrying on code exceptions
    return res.status(200).json({ status: 'error', message: error.message });
  }
};