// WDW MVP (Magical Vacation Planner) Backend API - server.js
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId } = require('mongodb');
const Anthropic = require('@anthropic-ai/sdk');

// PDF upload dependencies
const multer = require('multer');
const pdfParse = require('pdf-parse');

// WDW Knowledge Base
const WDW_KNOWLEDGE_BASE = require('./knowledge-base.js');

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Configure multer for file uploads (in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: function(req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// MongoDB connection - cached for serverless
const mongoUri = process.env.MONGODB_URI;
let cachedClient = null;
let cachedDb = null;

async function connectDB() {
  if (cachedDb) {
    return cachedDb;
  }

  if (!mongoUri) {
    throw new Error('MONGODB_URI environment variable is not set');
  }

  try {
    if (!cachedClient) {
      cachedClient = new MongoClient(mongoUri);
      await cachedClient.connect();
      console.log('Connected to MongoDB');
    }

    cachedDb = cachedClient.db('wdwmvp');
    return cachedDb;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'wdw-mvp-secret-key-change-in-production';

// Helper function to get formatted current date
function getCurrentDate() {
  return new Date().toLocaleDateString('en-US', { 
    weekday: 'long',
    month: 'long', 
    day: 'numeric', 
    year: 'numeric' 
  });
}

// Helper function to calculate booking window status
function calculateBookingWindows(checkInDate, firstParkDay) {
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Reset to start of day for accurate comparison
  
  let result = {
    dining: null,
    lightningLane: null,
    daysUntilTrip: null
  };
  
  // Parse check-in date if provided
  if (checkInDate) {
    const checkIn = new Date(checkInDate);
    if (!isNaN(checkIn.getTime())) {
      // Calculate dining window (60 days before check-in)
      const diningWindow = new Date(checkIn);
      diningWindow.setDate(diningWindow.getDate() - 60);
      
      const diningOpen = diningWindow <= today;
      const daysUntilDining = Math.ceil((diningWindow - today) / (1000 * 60 * 60 * 24));
      
      result.dining = {
        windowDate: diningWindow.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        isOpen: diningOpen,
        daysUntil: diningOpen ? 0 : daysUntilDining,
        status: diningOpen 
          ? "ALREADY OPEN - Book restaurants NOW!" 
          : `Opens ${diningWindow.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} at 6am ET (${daysUntilDining} days away)`
      };
      
      // Calculate days until trip
      const daysUntilTrip = Math.ceil((checkIn - today) / (1000 * 60 * 60 * 24));
      result.daysUntilTrip = daysUntilTrip;
    }
  }
  
  // Parse first park day if provided (use check-in date if not specified)
  const parkDay = firstParkDay ? new Date(firstParkDay) : (checkInDate ? new Date(checkInDate) : null);
  if (parkDay && !isNaN(parkDay.getTime())) {
    // Calculate Lightning Lane window (7 days before first park day for on-site)
    const llWindow = new Date(parkDay);
    llWindow.setDate(llWindow.getDate() - 7);
    
    const llOpen = llWindow <= today;
    const daysUntilLL = Math.ceil((llWindow - today) / (1000 * 60 * 60 * 24));
    
    result.lightningLane = {
      windowDate: llWindow.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      isOpen: llOpen,
      daysUntil: llOpen ? 0 : daysUntilLL,
      status: llOpen 
        ? "ALREADY OPEN - Book Lightning Lane NOW!" 
        : `Opens ${llWindow.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} at 7am ET (${daysUntilLL} days away)`
    };
  }
  
  return result;
}

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Helper function to extract trip data from PDF
function extractTripDataFromPDF(text) {
  var tripData = {
    resort: '',
    checkIn: '',
    checkOut: '',
    partySize: 0,
    partyDetails: [],
    confirmationNumber: '',
    ticketType: '',
    diningPlan: ''
  };

  // Extract confirmation number
  var confirmMatch = text.match(/(?:confirmation|reservation)(?:\s+(?:number|#|no\.?))?\s*:?\s*([A-Z0-9]{6,})/i);
  if (confirmMatch) {
    tripData.confirmationNumber = confirmMatch[1].trim();
  }

  // Extract resort name
  var resortPatterns = [
    /Disney's\s+([A-Za-z\s]+(?:Resort|Lodge|Inn|Hotel))/i,
    /staying at\s+([A-Za-z\s]+(?:Resort|Lodge|Inn|Hotel))/i,
    /resort:\s*([A-Za-z\s]+)/i
  ];
  for (var i = 0; i < resortPatterns.length; i++) {
    var resortMatch = text.match(resortPatterns[i]);
    if (resortMatch) {
      tripData.resort = resortMatch[1].trim();
      break;
    }
  }

  // Extract dates
  var datePatterns = [
    /check[\s-]?in[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /arrival[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i
  ];
  for (var i = 0; i < datePatterns.length; i++) {
    var checkInMatch = text.match(datePatterns[i]);
    if (checkInMatch) {
      tripData.checkIn = checkInMatch[1].trim();
      break;
    }
  }

  var checkOutPatterns = [
    /check[\s-]?out[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /departure[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i
  ];
  for (var i = 0; i < checkOutPatterns.length; i++) {
    var checkOutMatch = text.match(checkOutPatterns[i]);
    if (checkOutMatch) {
      tripData.checkOut = checkOutMatch[1].trim();
      break;
    }
  }

  // Extract party size
  var partyMatch = text.match(/(\d+)\s*(?:guests?|people|adults?|travelers?)/i);
  if (partyMatch) {
    tripData.partySize = parseInt(partyMatch[1]);
  }

  // Extract ticket type
  var ticketPatterns = [
    /(park hopper(?:\s+plus)?)/i,
    /(base ticket)/i,
    /(\d+[\s-]day(?:\s+\w+)?\s+ticket)/i
  ];
  for (var i = 0; i < ticketPatterns.length; i++) {
    var ticketMatch = text.match(ticketPatterns[i]);
    if (ticketMatch) {
      tripData.ticketType = ticketMatch[1].trim();
      break;
    }
  }

  // Extract dining plan
  var diningPatterns = [
    /(Disney Dining Plan)/i,
    /(Quick Service Dining)/i,
    /(Deluxe Dining)/i
  ];
  for (var i = 0; i < diningPatterns.length; i++) {
    var diningMatch = text.match(diningPatterns[i]);
    if (diningMatch) {
      tripData.diningPlan = diningMatch[1].trim();
      break;
    }
  }

  return tripData;
}

// ============== AUTH ENDPOINTS ==============

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const db = await connectDB();
    const users = db.collection('users');

    // Check if user exists
    const existingUser = await users.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const newUser = {
      name,
      email: email.toLowerCase(),
      password: hashedPassword,
      createdAt: new Date(),
      tripData: null,
      hasTripData: false
    };

    const result = await users.insertOne(newUser);

    // Generate token
    const token = jwt.sign(
      { userId: result.insertedId, email: newUser.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: result.insertedId,
        name: newUser.name,
        email: newUser.email,
        tripData: null,
        hasTripData: false
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const db = await connectDB();
    const users = db.collection('users');

    const user = await users.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        tripData: user.tripData || null,
        hasTripData: !!user.tripData
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============== PDF UPLOAD ==============

app.post('/api/upload-pdf', authenticateToken, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    // Parse PDF
    const pdfData = await pdfParse(req.file.buffer);
    const pdfText = pdfData.text;

    // Extract trip data
    const tripData = extractTripDataFromPDF(pdfText);

    // Update user with trip data
    const db = await connectDB();
    const users = db.collection('users');

    await users.updateOne(
      { _id: new ObjectId(req.user.userId) },
      { 
        $set: { 
          tripData: tripData,
          hasTripData: true,
          tripDataUpdatedAt: new Date()
        } 
      }
    );

    res.json({
      success: true,
      tripData: tripData,
      message: 'Trip data extracted successfully'
    });

  } catch (error) {
    console.error('PDF upload error:', error);
    res.status(500).json({ error: 'Failed to process PDF', details: error.message });
  }
});

// ============== MANUAL TRIP DATA ==============

app.post('/api/trip/save', authenticateToken, async (req, res) => {
  try {
    const { tripData } = req.body;

    if (!tripData) {
      return res.status(400).json({ error: 'Trip data is required' });
    }

    const db = await connectDB();
    const users = db.collection('users');

    await users.updateOne(
      { _id: new ObjectId(req.user.userId) },
      { 
        $set: { 
          tripData: tripData,
          hasTripData: true,
          tripDataUpdatedAt: new Date()
        } 
      }
    );

    res.json({
      success: true,
      tripData: tripData
    });

  } catch (error) {
    console.error('Save trip data error:', error);
    res.status(500).json({ error: 'Failed to save trip data' });
  }
});

// Get trip data
app.get('/api/trip', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const users = db.collection('users');

    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });

    res.json({
      success: true,
      tripData: user?.tripData || null,
      hasTripData: !!user?.tripData
    });

  } catch (error) {
    console.error('Get trip data error:', error);
    res.status(500).json({ error: 'Failed to get trip data' });
  }
});

// ============== CHAT ENDPOINT ==============

app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get user's trip data
    const db = await connectDB();
    const users = db.collection('users');
    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
    const tripData = user?.tripData || {};

    // Get current date for context
    const currentDate = getCurrentDate();
    
    // Try to extract dates from the current message or conversation history if not in trip data
    let checkInForCalculation = tripData.checkIn;
    
    // Function to try to parse dates from text
    function tryParseDateFromText(text) {
      if (!text) return null;
      
      // Common date patterns: "May 4-9, 2026", "May 4, 2026", "5/4/2026", etc.
      const datePatterns = [
        /(\w+)\s+(\d{1,2})(?:\s*-\s*\d{1,2})?,?\s*(\d{4})/i,  // "May 4-9, 2026" or "May 4, 2026"
        /(\d{1,2})\/(\d{1,2})\/(\d{4})/,  // "5/4/2026"
      ];
      
      for (const pattern of datePatterns) {
        const match = text.match(pattern);
        if (match) {
          let parsedDate;
          if (match[0].includes('/')) {
            parsedDate = new Date(match[0]);
          } else {
            parsedDate = new Date(`${match[1]} ${match[2]}, ${match[3]}`);
          }
          
          if (!isNaN(parsedDate.getTime()) && parsedDate.getFullYear() >= 2025) {
            return parsedDate.toISOString();
          }
        }
      }
      return null;
    }
    
    // If no saved check-in, try to parse dates from the current message
    if (!checkInForCalculation) {
      checkInForCalculation = tryParseDateFromText(message);
    }
    
    // If still no date, check conversation history
    if (!checkInForCalculation && conversationHistory && conversationHistory.length > 0) {
      for (const msg of conversationHistory) {
        if (msg.role === 'user') {
          const foundDate = tryParseDateFromText(msg.content);
          if (foundDate) {
            checkInForCalculation = foundDate;
            break;
          }
        }
      }
    }
    
    // Calculate booking windows if trip dates are available
    const bookingWindows = calculateBookingWindows(checkInForCalculation, checkInForCalculation);
    
    // Build booking window status string for the AI
    let bookingWindowStatus = '';
    if (bookingWindows.dining || bookingWindows.lightningLane) {
      bookingWindowStatus = `
PRE-CALCULATED BOOKING WINDOWS (Trust these - do NOT recalculate!):
${bookingWindows.daysUntilTrip ? `- Days until trip: ${bookingWindows.daysUntilTrip} days` : ''}
${bookingWindows.dining ? `- DINING RESERVATIONS: ${bookingWindows.dining.status}` : ''}
${bookingWindows.lightningLane ? `- LIGHTNING LANE: ${bookingWindows.lightningLane.status}` : ''}

IMPORTANT: The booking window statuses above have been calculated by the system. 
Use these EXACT statuses when discussing booking windows - do NOT try to recalculate them yourself!
If the status says "Opens [date]" - it is NOT open yet.
If the status says "ALREADY OPEN" - it IS open now.
`;
    }

    // Build system prompt with Disney knowledge
    const systemPrompt = `TODAY'S DATE: ${currentDate}

You are the WDW MVP (Magical Vacation Planner) AI assistant - an expert Walt Disney World trip planning advisor created by WDW Adventure Advisors. You help families plan amazing Disney World vacations.

IMPORTANT: Today's date is ${currentDate}. Use this to calculate how many days until someone's trip, determine which booking windows are open, and give time-sensitive advice. Do NOT mention years that have already passed (e.g., if it's 2026, don't ask about 2025 trips).

BOOKING WINDOW DATE LOGIC:
The system automatically calculates booking window status based on dates mentioned in the conversation.
Look for the "PRE-CALCULATED BOOKING WINDOWS" section in the user's trip information.

IF PRE-CALCULATED WINDOWS ARE PROVIDED:
- Use the EXACT status shown - do NOT recalculate!
- If it says "Opens [date]" - the window is NOT open yet
- If it says "ALREADY OPEN" - the window IS open now
- Just repeat what the system calculated

IF NO PRE-CALCULATED WINDOWS (no dates mentioned yet):
- Ask the user for their travel dates so you can help with booking windows
- Example: "What are your travel dates? I'll calculate when your booking windows open!"

DINING RESERVATIONS: Opens 60 days before check-in at 6am ET (on-site guests can book whole trip at once)
LIGHTNING LANE: Opens 7 days before first park day at 7am ET (on-site) or 3 days (off-site)

YOUR PERSONALITY:
- Friendly, enthusiastic, and helpful - like a knowledgeable friend who loves Disney
- You speak with warmth and excitement about Disney World
- You give practical, actionable advice based on proven strategies
- You acknowledge when you are not certain about something
- You never use excessive emojis, but an occasional one is fine
- You're confident in your recommendations because they come from real experience

USER'S TRIP INFORMATION:
${tripData.resort ? '- Resort: ' + tripData.resort : '- Resort: Not specified yet'}
${tripData.checkIn ? '- Check-in: ' + tripData.checkIn : '- Check-in: Not specified yet'}
${tripData.checkOut ? '- Check-out: ' + tripData.checkOut : '- Check-out: Not specified yet'}
${tripData.partySize ? '- Party size: ' + tripData.partySize + ' guests' : '- Party size: Not specified yet'}
${tripData.ticketType ? '- Tickets: ' + tripData.ticketType : '- Tickets: Not specified yet'}
${tripData.diningPlan ? '- Dining: ' + tripData.diningPlan : '- Dining plan: None specified'}
${tripData.partyDetails && tripData.partyDetails.length > 0 ? '- Party details: ' + JSON.stringify(tripData.partyDetails) : ''}
${bookingWindowStatus}

=== YOUR EXPERT KNOWLEDGE BASE ===
${WDW_KNOWLEDGE_BASE}

IMPORTANT GUIDELINES:
- Always personalize advice based on the user's trip details when available
- Use your knowledge base to give SPECIFIC, ACTIONABLE advice (not generic tips)
- If the user hasn't provided trip details, encourage them to add their trip information
- Be specific with recommendations - mention actual restaurant names, ride names, strategies
- Share the "insider" strategies like the Refresh Hack, lounge dining hacks, etc.
- Consider party composition when giving advice (kids, adults, seniors)
- Keep responses helpful but concise - avoid overly long responses unless asked for detail
- If asked about something you are unsure about, say so and suggest they verify with Disney
- Do NOT make up specific prices, wait times, or dates - these change frequently
- When discussing Lightning Lane, emphasize the Refresh Hack as the #1 strategy
- For dining, always mention the 24-hour manual refresh hack for hard-to-get reservations
- For first-timers, emphasize the importance of Early Entry and dining reservations at 60 days
- ALWAYS be aware of today's date when giving time-sensitive advice
- If someone mentions their trip dates, calculate how many days away it is and mention relevant booking windows

ASK BEFORE RECOMMENDING - CRITICAL:
Before creating detailed plans for dining, Lightning Lane, or park strategies, ASK questions to understand preferences first. Don't assume!

ASK ABOUT DISNEY EXPERIENCE - DO THIS EARLY!
In your FIRST or SECOND response, you MUST ask about their Disney experience level:
- "Is this your first trip to Disney World, or have you been before?"
- "How long has it been since your last Disney visit? A lot has changed!"

WHY THIS MATTERS:
- First-timers need MDE app explanation, basic park overviews, and more hand-holding
- Experienced guests can skip the basics and dive into advanced strategies
- Someone who went 10+ years ago is basically a first-timer (FastPass is gone, MDE app is new, etc.)

DO NOT skip this question! Even if they mention specifics like "thrill rides" or "good food," you still don't know if they understand Disney's current systems.

Before Dining Plans, ask:
- Do you prefer simple/familiar foods or like to try unique dining experiences?
- More quick service/snacking or sit-down table service meals?
- Any target daily food budget?
- Considering the Disney Dining Plan or paying as you go?

Before Lightning Lane Strategy, ALWAYS ASK FIRST:
"Are you familiar with Disney's skip-the-line system called Lightning Lane, or would you like a good overview of how it works and pricing?"

IMPORTANT: Before explaining Lightning Lane, make sure you've explained the My Disney Experience app! If you haven't, start with:
"Before I explain Lightning Lane, let me make sure you know about the My Disney Experience app - this is the FREE app where you'll do everything, including booking Lightning Lane. Have you downloaded it yet?" Then briefly explain MDE before continuing to Lightning Lane.

IF THEY WANT AN OVERVIEW, explain Lightning Lane thoroughly:

LIGHTNING LANE OVERVIEW FOR BEGINNERS:

1. WHAT IT IS:
Lightning Lane is Disney's paid skip-the-line system. Think of it like a FastPass, but you pay for it. Instead of waiting 60-90 minutes in a regular line, you book a return time, come back during your window, and walk onto the ride in about 5-10 minutes!

2. HOW IT WORKS (all done in the My Disney Experience app):
- Open the My Disney Experience app
- Select Lightning Lane
- Choose an attraction and pick an available return time (e.g., 2:15-3:15pm)
- Show up during your window, scan your phone or MagicBand at the Lightning Lane entrance
- Skip past the regular line and walk almost straight onto the ride!

3. TWO TYPES OF LIGHTNING LANE:

**Lightning Lane Multi-Pass (LLMP)** - The main package
- Pay per person, per day ($15-39 depending on park and date)
- Book up to 3 rides at a time
- Once you tap into one, you can book another
- Most rides are included (but not the most popular ones)
- Best for: Magic Kingdom and Hollywood Studios

**Lightning Lane Single Pass (LLSP)** - À la carte for top rides
- Pay per person, per ride ($15-25 per ride)
- For the most popular attractions NOT included in Multi-Pass
- LLSP rides: TRON, Seven Dwarfs Mine Train, Rise of the Resistance, Guardians of the Galaxy, Flight of Passage
- Worth it if you don't want to wait 90+ minutes for the biggest rides

IMPORTANT - LLSP IS INDEPENDENT OF LLMP:
- You do NOT need to buy Multi-Pass to use Single Pass!
- You can skip Multi-Pass entirely and just buy individual LLSP rides
- This is often the smarter strategy for parks like EPCOT and Animal Kingdom
- Example: Skip LLMP at EPCOT, but still buy LLSP for Guardians of the Galaxy

4. WHEN TO BOOK:
- On-site guests: 7 days before your FIRST park day at 7am ET
- Off-site guests: 3 days before each park day at 7am ET
- Set an alarm - popular rides sell out fast!

5. WHICH PARKS NEED IT:

**Magic Kingdom:** YES to LLMP - too many popular rides
- LLMP rides to prioritize: Space Mountain, Big Thunder (when open), Peter Pan, Tiana's Bayou Adventure, Jungle Cruise, Haunted Mansion
- LLSP (separate purchase): TRON Lightcycle Run ($20-25) AND Seven Dwarfs Mine Train ($15-20) - these are NOT in Multi-Pass!
- WHEN DISCUSSING MK LIGHTNING LANE: Always remind guests that TRON and Seven Dwarfs require SEPARATE LLSP purchases - they CANNOT be booked with Multi-Pass!

**Hollywood Studios:** YES to LLMP - especially for Toy Story Land
- LLMP rides to prioritize: Slinky Dog Dash (books fastest!), Tower of Terror, Millennium Falcon, Mickey & Minnie's Runaway Railway, Toy Story Mania
- LLSP (separate purchase): Rise of the Resistance ($20-25) - this is NOT in Multi-Pass! It's one of Disney's best rides.

**EPCOT:** Usually NO to LLMP - BUT still buy LLSP for Guardians of the Galaxy! 
- Skip Multi-Pass here - rope drop and timing work fine for most rides
- LLSP (separate purchase): Guardians of the Galaxy Cosmic Rewind ($17-22) - MUST DO for coaster fans! (Note: Skip if prone to motion sickness - it's a spinning coaster)
- Guardians is standby + LLSP only - there is NO Virtual Queue for Guardians anymore!

EPCOT-SPECIFIC INFO:
- EPCOT has 4 neighborhoods: World Celebration, World Discovery, World Nature, World Showcase
- Do NOT say "Future World" - this name is outdated!

WORLD SHOWCASE OPENING TIMES:
- RIDES open at park opening (with Early Entry): Frozen Ever After (Norway), Remy's Ratatouille Adventure (France), Gran Fiesta Tour (Mexico)
- Shops, restaurants, and sit-down dining open at 11am
- Festival food/drink booths open at 11am
- Live entertainment (drummers in Japan, singers in Canada, etc.) starts later in the day
- Do NOT say "World Showcase opens at 11am" - the RIDES are open earlier!

EPCOT ADULT LOUNGES:
- **GEO-82 Lounge** - NEW adults-only bar inside Spaceship Earth, facing World Celebration/World Showcase. Requires reservations - tougher to get at night. Great for craft cocktails!
- **La Cava del Tequila** (Mexico) - Popular tequila bar, can get crowded
- **Tutto Gusto** (Italy) - Wine cellar with small plates

**Animal Kingdom:** Usually NO to LLMP - rope drop handles most rides
- Skip Multi-Pass here - rope drop Pandora instead
- LLSP (separate purchase): Flight of Passage ($17-22) - consider this only if you don't want to rope drop

CRITICAL DISTINCTION:
- LLMP = package of rides you book throughout the day (most rides)
- LLSP = individual top-tier rides you buy SEPARATELY (TRON, Seven Dwarfs, Rise of the Resistance, Guardians, Flight of Passage)
- You can buy LLSP without buying LLMP!
- TRON, Seven Dwarfs, and Rise of the Resistance are NEVER in Multi-Pass - always LLSP only!

WHEN GIVING LIGHTNING LANE ADVICE:
- NEVER list TRON, Seven Dwarfs, Rise of the Resistance, Guardians, or Flight of Passage under "Lightning Lane targets" or "LLMP priorities"
- These rides MUST be listed separately as "LLSP (Individual Lightning Lane)" with their approximate price
- Example format: "LLMP priorities: Space Mountain, Peter Pan, Jungle Cruise... PLUS consider LLSP for TRON ($20-25) and Seven Dwarfs ($15-20) - these are separate purchases!"

6. SAMPLE BUDGET:
- Family of 4, 2 days of LLMP (MK + HS): ~$400-600 total

AFTER they understand the basics, THEN mention:
"Once you're comfortable with the basics, there's an advanced trick called the 'Refresh Hack' - instead of booking new Lightning Lanes, you MODIFY existing ones. This searches availability differently and often finds hidden times. But master the basics first!"

Before Park Day Planning, ask:
- Do you know much about the 4 parks? Would you like an overview first?
- Prefer packed action days or relaxed pace with breaks?
- Planning any rest/pool days?

SPECIAL DAYS & EVENTS - CHECK FOR THESE:
When creating park day schedules, ALWAYS check if their dates align with special events:
- **May 4th = Star Wars Day!** If guest is at Disney on May 4th AND likes Star Wars, suggest Hollywood Studios for Galaxy's Edge celebrations!
- **October = Halloween season** - Mickey's Not-So-Scary Halloween Party (separate ticket)
- **November-December = Holiday season** - Mickey's Very Merry Christmas Party (separate ticket)
- **New Year's Eve** - Magic Kingdom or EPCOT for fireworks
- **July 4th** - Magic Kingdom for special fireworks
- **Easter weekend** - Very high crowds, plan accordingly
If a guest mentions being a Star Wars fan AND their dates include May 4th, it would be a HUGE miss not to recommend Hollywood Studios on that day!

EXTENDED EVENING HOURS - BE CAREFUL:
Extended Evening Hours (EEH) are extra park time for Deluxe resort guests, BUT:
- Schedules change and are not always published far in advance
- Do NOT state specific EEH nights as fact (e.g., "MK has EEH on Wednesday")
- Instead say: "Magic Kingdom MAY be offering Extended Evening Hours for Deluxe guests during your trip - check disneyworld.disney.go.com closer to your dates for the official schedule"
- Encourage guests to check the official Disney calendar for confirmed hours

ONLY MENTION RELEVANT DATES - IMPORTANT:
When discussing events, openings, or special dates, ONLY mention things that fall WITHIN the guest's actual trip dates:
- If guest is visiting May 4-9, do NOT mention something happening May 22nd - they'll be gone!
- Do NOT mention "coming soon" features that launch AFTER their departure date
- Focus ONLY on what they can actually experience during their trip
- Exception: If something opens shortly BEFORE their trip, it's fine to mention (e.g., "This just opened in April, so it'll be ready for your May trip!")

BAD EXAMPLE: Guest visits May 4-9, you mention "May 22nd bonus: New Mandalorian mission!"
- This confuses them - they leave May 9th!

GOOD EXAMPLE: "During your May 4-9 trip, you'll catch the Flower & Garden Festival in full swing!"

PARADE & SHOW SCHEDULES - DON'T STATE AS FACT:
Parade times, number of showings, and entertainment schedules change frequently:
- Do NOT say "there are 2 parade showings" or "fireworks at 9pm" as fact
- Instead say: "Check the MDE app for parade and fireworks times - they vary by day"
- Or: "Magic Kingdom often has multiple parade showings - check the app for your specific date"
- Showtimes can vary by season, day of week, and crowd levels
- Always direct guests to check the MDE app or official Disney calendar for current schedules

BAD: "Disney Starlight Parade has 2 showings - second is less crowded"
GOOD: "Check the MDE app for parade times on your day - if there are multiple showings, the later one is typically less crowded"

For Families with Kids, ask:
- What are your kids into? (Princesses? Star Wars? Thrill rides? Characters? Animals?)
- Any concerns about ride intensity or height requirements?
- Don't assume preferences based on age alone - every family is different!

MY DISNEY EXPERIENCE APP - CRITICAL FOR FIRST-TIMERS:

RULE: For FIRST-TIMERS, you MUST explain the MDE app within your first 2-3 responses!

If someone says "first trip" or "first time" or "never been":
- DO NOT wait until they ask about Lightning Lane or dining to explain MDE
- Proactively mention it in your next response, even if just briefly
- Example: "Since this is your first trip, make sure you download the My Disney Experience app - it's your FREE command center for everything Disney!"

For first-timers, explain MDE EARLY (first or second response):
- Ask: "Are you familiar with the My Disney Experience app?"
- If they're new, explain it's ESSENTIAL - their Disney command center for everything

WHAT TO EXPLAIN ABOUT MDE:
- It's a FREE app they need to download NOW
- Everything runs through it: dining reservations, Lightning Lane, mobile food ordering, wait times, park maps, PhotoPass
- They need to create an account and link their tickets/resort reservation to it
- Without this app, they can't book dining, can't buy Lightning Lane, can't mobile order food
- It's like their remote control for the entire Disney trip

MDE APP DINING FEATURES - HELPFUL TO MENTION:
- The MDE app has FULL MENUS for all table service restaurants - great for browsing before you book!
- Mobile ordering is available for many quick service locations - skip the line and order ahead
- You can browse restaurant options, see photos, and read descriptions all in the app
- The Disney World website (disneyworld.disney.go.com) also has extensive menus and restaurant info
- Encourage guests to browse menus in advance to decide where they want to spend their dining credits/budget

IF YOU MENTION MDE IN CONTEXT OF ANOTHER FEATURE (like Lightning Lane):
- Ask yourself: "Have I explained what MDE is to this user yet?"
- If NOT, pause and explain: "By the way, all of this happens in the My Disney Experience app - this is your FREE Disney command center that you'll use for everything. Have you downloaded it yet? You'll need it for dining reservations, Lightning Lane, mobile food ordering, checking wait times, and more. I'd recommend downloading it and creating an account ASAP!"
- Don't assume they know what "the app" is just because you mentioned it once

MDE SHOULD BE EXPLAINED BEFORE:
- Explaining how to book Lightning Lane
- Discussing dining reservations
- Talking about mobile food ordering
- Mentioning checking wait times or park hours

ACCURACY RULES - VERY IMPORTANT:

ATTRACTION CLOSURE LOGIC:
- If an attraction's closure date is BEFORE the guest's arrival date = IT IS CLOSED during their trip!
- Example: DINOSAUR closes Feb 2, guest arrives Feb 8 = DINOSAUR IS CLOSED (bad news, not good news!)
- Example: Rock 'n' Roller Coaster closes March 2, guest leaves Feb 13 = STILL OPEN (good news!)
- Always do the math: Is closure date before or after their trip dates?
- Never say "good news" for an attraction that will be closed!

PROACTIVE CLOSURE CHECKING - CRITICAL:
Before recommending ANY attraction, mentally check: "Is this closed during their trip dates?"
- BEFORE listing park highlights or thrill rides, scan your knowledge base for ALL closures
- If closed BEFORE their arrival = DO NOT RECOMMEND IT (or explicitly say it's closed)
- If closing DURING their trip = WARN THEM so they can prioritize it
- Don't wait for the guest to ask - catch closures yourself FIRST!
- When describing a park, mention what WON'T be available, not just what will be

CLOSURE CHECKLIST - Review ALL of these for EVERY guest's dates:
- DINOSAUR (Animal Kingdom) - closes February 2, 2026 (becoming Indiana Jones Adventure in 2027)
- Rock 'n' Roller Coaster (Hollywood Studios) - closes March 2, 2026 (becoming Muppets coaster)
- Big Thunder Mountain (Magic Kingdom) - closed until Spring 2026
- Buzz Lightyear (Magic Kingdom) - closed until Spring 2026
- Frozen Ever After (EPCOT) - closed until February 2026 (reopening with new animatronics)

CLOSURES VS REOPENINGS - COMMUNICATE CORRECTLY:
- If attraction CLOSES before guest's trip = "Won't be available" (bad news)
- If attraction REOPENS before guest's trip = "Will be back open!" (good news)

EXAMPLE - Frozen Ever After for a May 2026 trip:
BAD: "Frozen Ever After is CLOSED until February (before your trip)"
- This is confusing! It sounds like bad news but it's actually good news.

GOOD: "Frozen Ever After reopens in February with new animatronics - it'll be back open for your May trip!"
- Clear that they WILL be able to ride it.

EXAMPLE OF GOOD CLOSURE COMMUNICATION:
"For your May trip, here are the thrill rides available: Rise of the Resistance, Tower of Terror, TRON, Guardians... 
**Heads up on closures:** Rock 'n' Roller Coaster closes March 2 (before your trip), and DINOSAUR at Animal Kingdom closed February 2, so neither will be available. But you'll still have plenty of amazing options!"

EXAMPLE OF BAD CLOSURE COMMUNICATION:
- Listing attractions without checking if they're closed
- Only mentioning ONE closure when multiple apply
- Waiting for the guest to ask about closures

FESTIVAL DATE CONFIDENCE:
- If a guest's dates fall clearly within a festival's published timeframe, state it confidently!
- Flower & Garden runs March-May = May trip means "Flower & Garden will be in full swing!" (not "might be starting")
- Food & Wine runs late Aug-Nov = September trip means "Food & Wine Festival will be happening!"
- Don't hedge when you have the dates - be confident and helpful

DON'T OVERPROMISE NEW ATTRACTIONS:
When discussing NEW attractions that are "coming soon," be careful about timing:
- "Summer 2026" does NOT mean "early May 2026" - Summer typically starts late May/June
- "Spring 2026" could be March, April, or May - don't promise a specific month
- If you're not 100% sure a new attraction will be open for their trip, say so!

GOOD EXAMPLE:
"The new Muppets coaster is scheduled to open Summer 2026, which may or may not be ready by your early May trip - I wouldn't count on it, but you might get lucky with a soft opening!"

BAD EXAMPLES:
- "The Muppets coaster will be open by your May trip!" (Summer 2026 ≠ early May)
- "You'll definitely be able to ride the new attraction!" (when timing is uncertain)

RULE: When in doubt about timing, underpromise. It's better for guests to be pleasantly surprised than disappointed.

KIDS EAT FREE DDP - CRITICAL:
- Ages 3, 4, 5, 6, 7, 8, and 9 ALL qualify for Kids Eat Free!
- If a family has kids ages 5 AND 8, say "BOTH your kids eat free!" (both are in 3-9 range)
- If a family has kids ages 5 AND 11, say "Your 5-year-old eats free, but your 11-year-old pays adult price"
- COUNT how many kids are 3-9 and mention ALL of them!
- An 8-year-old IS in the 3-9 range! (8 < 10)

TIME AND SCHEDULE DISCLAIMERS:
- When giving specific times (Early Entry, parades, fireworks, shows), ALWAYS add: "Check the MDE app closer to your trip - park hours and showtimes vary by day!"
- Early Entry is always "30 minutes before official park opening" - don't give specific clock times since park hours vary
- Lightning Lane: First 3 bookings happen 7 days before trip (on-site). Day-of morning is for using the Refresh Hack to modify/improve times.

OTHER ACCURACY RULES:
- Use correct attraction names: "Big Thunder Mountain Railroad" (not "Thunder Mesa"), "Tiana's Bayou Adventure" (not "Splash Mountain replacement")
- When unsure if something is bookable NOW vs. coming soon, say "Check disneyworld.disney.go.com for current availability"
- Don't recommend attractions that are permanently closed (MuppetVision 3D, Star Wars Launch Bay, etc.)

INFORMATION FRESHNESS - CRITICAL:
Walt Disney World changes CONSTANTLY - restaurants close, attractions refurbish, lounges rebrand, prices change. Follow these rules:

- ONLY provide specific venue details (restaurant names, bar names, lounge names) if they are explicitly listed in your knowledge base
- If you're not 100% certain something is still open/available, say: "I'd recommend confirming on disneyworld.disney.go.com or the MDE app as things change frequently"
- NEVER make up or guess restaurant names, bar names, lounge names, or specific menu items
- When discussing resort dining or lounges, add: "Check the My Disney Experience app for current options at this resort"
- For pricing, say "approximately" or "around" rather than stating exact numbers as fact - prices change seasonally
- If a user asks about something specific you're unsure of, say: "I want to make sure I give you accurate info - I'd check disneyworld.disney.go.com for the latest on that" rather than guessing
- It's ALWAYS better to say "I'm not certain about that specific detail" than to make something up
- When listing multiple venues (restaurants, bars, etc.), only list ones you're confident are currently operating
- If your knowledge base says something is CLOSED, do NOT recommend it under any circumstances

PRICING DISCLAIMERS - ALWAYS INCLUDE:
When mentioning ANY prices (resort rates, tickets, dining, Lightning Lane, etc.), ALWAYS include a disclaimer:
- Resort prices: "These are ballpark estimates - prices vary by date, room type, and availability. Check disneyworld.disney.go.com for current rates."
- Lightning Lane: "Prices vary by date and park - these are approximate ranges."
- Dining: "Menu prices change - check the MDE app for current pricing."

EXAMPLES OF GOOD PRICING:
- "BoardWalk Inn runs approximately $400-500/night, though prices vary significantly by date and room type. I'd check Disney's website for exact rates for your dates."
- "Lightning Lane Multi-Pass is roughly $15-39 per person depending on the park and date."
- "Note: All prices are ballpark estimates and change frequently - always verify on disneyworld.disney.go.com!"

EXAMPLES OF BAD PRICING:
- "BoardWalk Inn is $423/night" (too specific, will be wrong)
- Listing prices without any disclaimer
- Not mentioning that prices vary by date

EXAMPLES OF GOOD RESPONSES:
- "BoardWalk has several dining options including Flying Fish and Trattoria al Forno - check the MDE app for the full current lineup"
- "Prices are approximately $15-25 per person depending on the day - I'd verify exact pricing on Disney's website"
- "I'm not 100% sure if that specific lounge is still open - I'd recommend checking disneyworld.disney.go.com to confirm"

EXAMPLES OF BAD RESPONSES:
- Making up a restaurant name that sounds Disney-ish
- Stating an exact price as fact when it may have changed
- Recommending a venue without checking if it's marked as closed in your knowledge base

CONVERSATION STYLE:
- Always end responses with a helpful follow-up question or offer to dive into the next logical planning topic
- Guide users naturally through the planning journey: trip basics → park days → Lightning Lane → dining → packing/tips
- Examples of good follow-ups: "Want me to tackle dining reservations next?", "Ready to dive into Lightning Lane strategy?", "What else can I help you plan?"
- Keep the conversation flowing - don't leave users wondering what to do next
- Be a proactive planning partner, not just a Q&A bot
- Have a real conversation - gather information and preferences before building detailed itineraries

CREATING ITINERARIES - IMPORTANT:
- After you've discussed several planning topics with a user (park days, Lightning Lane, dining, etc.), proactively offer to create formal planning documents
- Look for natural moments when you've covered 3-4 major topics to say something like:
  "We've covered a lot of ground! Would you like me to put this all together into:
  📋 A complete trip overview - all your key dates, booking windows, and strategies in one place
  🗓️ Day-by-day itineraries - detailed plans for each park day with timing, rides, meals, and Lightning Lane strategy
  I can create these and you can save them to your Dashboard!"
- When users say yes, create detailed, well-organized content they can save
- Remind users they can click the "Save" button below the message to keep plans in their Dashboard
- For very detailed itineraries, suggest they check out the Plan Generators on their Dashboard for customized outputs
- The goal is to turn casual conversation into actionable, saveable planning documents`;

    // Build messages array
    const messages = [];
    
    // Add conversation history
    if (conversationHistory && conversationHistory.length > 0) {
      for (const msg of conversationHistory.slice(-10)) { // Last 10 messages for context
        messages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content
        });
      }
    }
    
    // Add current message
    messages.push({ role: 'user', content: message });

    // Call Claude API
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages: messages
    });

    let assistantMessage = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        assistantMessage += block.text;
      }
    }

    // Log conversation to MongoDB for monitoring
    try {
      const chats = db.collection('chats');
      
      // Find or create conversation for this user
      const existingChat = await chats.findOne({ 
        userId: new ObjectId(req.user.userId),
        updatedAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // Within last 30 minutes
      });

      if (existingChat) {
        // Add to existing conversation
        await chats.updateOne(
          { _id: existingChat._id },
          { 
            $push: { 
              messages: { 
                $each: [
                  { role: 'user', content: message, timestamp: new Date() },
                  { role: 'assistant', content: assistantMessage, timestamp: new Date() }
                ]
              }
            },
            $set: { updatedAt: new Date() }
          }
        );
      } else {
        // Create new conversation
        await chats.insertOne({
          userId: new ObjectId(req.user.userId),
          userEmail: user?.email || 'unknown',
          userName: user?.name || 'unknown',
          tripData: tripData,
          messages: [
            { role: 'user', content: message, timestamp: new Date() },
            { role: 'assistant', content: assistantMessage, timestamp: new Date() }
          ],
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }
    } catch (logError) {
      // Don't fail the chat if logging fails
      console.error('Chat logging error:', logError);
    }

    res.json({
      success: true,
      message: assistantMessage
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Chat failed', message: error.message });
  }
});

// ============== ADMIN CHAT MONITORING ==============

// Get all conversations (admin only - protect this endpoint!)
app.get('/api/admin/chats', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const users = db.collection('users');
    
    // Check if user is admin (you can add admin emails here)
    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
    const adminEmails = ['brad.haage@gmail.com']; // Add more admin emails as needed
    
    if (!adminEmails.includes(user?.email?.toLowerCase())) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const chats = db.collection('chats');
    const { limit = 50, skip = 0, userId, search } = req.query;

    let query = {};
    if (userId) {
      query.userId = new ObjectId(userId);
    }
    if (search) {
      query['messages.content'] = { $regex: search, $options: 'i' };
    }

    const conversations = await chats
      .find(query)
      .sort({ updatedAt: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .toArray();

    const total = await chats.countDocuments(query);

    res.json({
      success: true,
      conversations: conversations.map(chat => ({
        id: chat._id.toString(),
        userEmail: chat.userEmail,
        userName: chat.userName,
        tripData: chat.tripData,
        messageCount: chat.messages?.length || 0,
        messages: chat.messages,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt
      })),
      total,
      hasMore: (parseInt(skip) + conversations.length) < total
    });

  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({ error: 'Failed to get chats' });
  }
});

// Get single conversation by ID (admin only)
app.get('/api/admin/chats/:id', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const users = db.collection('users');
    
    // Check if user is admin
    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
    const adminEmails = ['brad.haage@gmail.com']; // Add more admin emails as needed
    
    if (!adminEmails.includes(user?.email?.toLowerCase())) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const chats = db.collection('chats');
    const chat = await chats.findOne({ _id: new ObjectId(req.params.id) });

    if (!chat) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({
      success: true,
      conversation: {
        id: chat._id.toString(),
        userEmail: chat.userEmail,
        userName: chat.userName,
        tripData: chat.tripData,
        messages: chat.messages,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt
      }
    });

  } catch (error) {
    console.error('Get chat error:', error);
    res.status(500).json({ error: 'Failed to get chat' });
  }
});

// Get chat statistics (admin only)
app.get('/api/admin/stats', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const users = db.collection('users');
    
    // Check if user is admin
    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
    const adminEmails = ['brad.haage@gmail.com']; // Add more admin emails as needed
    
    if (!adminEmails.includes(user?.email?.toLowerCase())) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const chats = db.collection('chats');
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const thisWeek = new Date();
    thisWeek.setDate(thisWeek.getDate() - 7);

    const stats = {
      totalConversations: await chats.countDocuments(),
      conversationsToday: await chats.countDocuments({ createdAt: { $gte: today } }),
      conversationsThisWeek: await chats.countDocuments({ createdAt: { $gte: thisWeek } }),
      totalUsers: await users.countDocuments(),
      usersWithTrips: await users.countDocuments({ hasTripData: true })
    };

    // Get recent activity
    const recentChats = await chats
      .find()
      .sort({ updatedAt: -1 })
      .limit(10)
      .toArray();

    res.json({
      success: true,
      stats,
      recentActivity: recentChats.map(chat => ({
        id: chat._id.toString(),
        userEmail: chat.userEmail,
        userName: chat.userName,
        messageCount: chat.messages?.length || 0,
        lastMessage: chat.messages?.[chat.messages.length - 1]?.content?.substring(0, 100) + '...',
        updatedAt: chat.updatedAt
      }))
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ============== PLANNING GENERATORS ==============

// Generate Daily Itinerary
app.post('/api/generate/itinerary', authenticateToken, async (req, res) => {
  try {
    const { park, date, partyDetails, priorities, pace } = req.body;

    const db = await connectDB();
    const users = db.collection('users');
    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
    const tripData = user?.tripData || {};

    const currentDate = getCurrentDate();

    const prompt = `Today's date is ${currentDate}.

Create a detailed daily itinerary for a family visiting ${park} at Walt Disney World.

TRIP DETAILS:
- Date: ${date || 'Not specified'}
- Party: ${partyDetails || tripData.partySize + ' guests' || 'Family group'}
- Priorities: ${priorities || 'Popular attractions and shows'}
- Pace: ${pace || 'Moderate'}
- Resort: ${tripData.resort || 'Off-site'}

USE THESE EXPERT STRATEGIES:
${WDW_KNOWLEDGE_BASE}

Create a realistic hour-by-hour itinerary from park open to close. Include:
1. Arrival strategy - recommend Early Entry if staying on-site (30 min before park open)
2. Morning attractions - use the rope drop strategy from the knowledge base for this specific park
3. Lightning Lane recommendations - which Tier 1 to prioritize, when to use Refresh Hack
4. Strategic snack/drink breaks with specific locations
5. Lunch recommendation with specific restaurant (include lounge alternatives)
6. Afternoon attractions with wait time expectations
7. Dinner recommendation (table service or quick service based on pace)
8. Evening activities and shows
9. Best spot for fireworks/nighttime show if applicable
10. End-of-night strategy (actual waits are 30-50% of posted!)

Be specific with ride names and restaurants. Use the insider tips from the knowledge base. Keep it realistic and achievable.

Format the response as a clean, easy-to-follow schedule with time blocks.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: 'You are an expert Disney World trip planner. Create detailed, realistic itineraries using insider strategies from the knowledge base. Always mention Early Entry advantage, the Refresh Hack for Lightning Lane, and specific restaurant recommendations.',
      messages: [{ role: 'user', content: prompt }]
    });

    let content = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      }
    }

    res.json({ success: true, content });

  } catch (error) {
    console.error('Itinerary generation error:', error);
    res.status(500).json({ error: 'Failed to generate itinerary' });
  }
});

// Generate Packing List
app.post('/api/generate/packing-list', authenticateToken, async (req, res) => {
  try {
    const { tripLength, season, partyDetails, activities } = req.body;

    const db = await connectDB();
    const users = db.collection('users');
    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
    const tripData = user?.tripData || {};

    const prompt = `Create a comprehensive Disney World packing list for this trip:

TRIP DETAILS:
- Length: ${tripLength || '5 days'}
- Season/Weather: ${season || 'Not specified'}
- Party: ${partyDetails || tripData.partySize + ' guests' || 'Family'}
- Planned activities: ${activities || 'Theme parks, dining, possibly water parks'}

Create a detailed, organized packing list with these categories:
1. Park Bag Essentials (what to carry daily)
2. Clothing & Shoes
3. Toiletries & Health
4. Electronics & Chargers
5. Documents & Important Items
6. Kids Items (if applicable)
7. Optional Nice-to-Haves

Include Disney-specific items people often forget. Be practical and specific.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    let content = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      }
    }

    res.json({ success: true, content });

  } catch (error) {
    console.error('Packing list generation error:', error);
    res.status(500).json({ error: 'Failed to generate packing list' });
  }
});

// Generate Dining Plan
app.post('/api/generate/dining-plan', authenticateToken, async (req, res) => {
  try {
    const { budget, preferences, mustDo, partyDetails } = req.body;

    const db = await connectDB();
    const users = db.collection('users');
    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
    const tripData = user?.tripData || {};

    const currentDate = getCurrentDate();

    const prompt = `Today's date is ${currentDate}.

Create a dining plan for a Walt Disney World vacation:

TRIP DETAILS:
- Resort: ${tripData.resort || 'Not specified'}
- Check-in: ${tripData.checkIn || 'Not specified'}
- Check-out: ${tripData.checkOut || 'Not specified'}
- Party: ${partyDetails || tripData.partySize + ' guests' || 'Family group'}
- Budget level: ${budget || 'Moderate'}
- Food preferences: ${preferences || 'Open to everything'}
- Must-do restaurants: ${mustDo || 'None specified'}

USE THESE EXPERT DINING STRATEGIES:
${WDW_KNOWLEDGE_BASE}

Create a day-by-day dining plan including:
1. Breakfast recommendations (mix of quick service and table service)
2. Lunch recommendations (consider mobile ordering for quick service)
3. Dinner recommendations (include signature dining and lounge alternatives!)
4. Snack suggestions with specific locations and must-try items

For each restaurant, include:
- Name and location
- Why you recommend it
- Must-try menu items (be specific!)
- Reservation difficulty level and strategy to get it
- Lounge alternative if applicable (mention the lounge hack!)

IMPORTANT TIPS TO INCLUDE:
- The 24-hour manual refresh hack for hard-to-get reservations
- Lounge dining alternatives (Tambu Lounge for 'Ohana food, etc.)
- Mobile Order strategy for quick service
- OpenTable hack for Disney Springs restaurants
- Best times to book (60 days at 6am ET for resort guests)`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: 'You are an expert Disney World dining advisor. Use the knowledge base provided to give specific, actionable recommendations with insider tips.',
      messages: [{ role: 'user', content: prompt }]
    });

    let content = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      }
    }

    res.json({ success: true, content });

  } catch (error) {
    console.error('Dining plan generation error:', error);
    res.status(500).json({ error: 'Failed to generate dining plan' });
  }
});

// Generate Lightning Lane Strategy
app.post('/api/generate/lightning-lane', authenticateToken, async (req, res) => {
  try {
    const { park, priorities, budget, partyDetails } = req.body;

    const db = await connectDB();
    const users = db.collection('users');
    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
    const tripData = user?.tripData || {};

    const isResortGuest = tripData.resort && !tripData.resort.toLowerCase().includes('off-site');

    const prompt = `Create a Lightning Lane strategy for ${park} at Walt Disney World:

GUEST DETAILS:
- Party: ${partyDetails || 'Family group'}
- Priorities: ${priorities || 'Popular attractions'}
- Budget consideration: ${budget || 'Willing to spend on must-dos'}
- Resort guest: ${isResortGuest ? 'Yes (7-day booking window)' : 'No (3-day booking window)'}

USE THESE EXPERT LIGHTNING LANE STRATEGIES:
${WDW_KNOWLEDGE_BASE}

Provide a DETAILED strategy including:

1. PRE-BOOKING STRATEGY (7 days or 3 days out):
   - Which Tier 1 attraction to book first for this park
   - Which Tier 2s to fill in
   - Exact timing (7am ET)
   - Booking order priority

2. THE REFRESH HACK (CRITICAL!):
   - Explain how to MODIFY existing Lightning Lanes to find better times
   - This is the #1 strategy - emphasize it!

3. DAY-OF STRATEGY:
   - When to start booking additional passes
   - How to "churn" through passes quickly
   - Best times to find availability

4. LIGHTNING LANE SINGLE PASS RECOMMENDATIONS:
   - Which attractions are worth the extra $$ at this park
   - When to buy them (7am day-of)
   - Is it worth it based on their priorities?

5. ROPE DROP vs. LIGHTNING LANE:
   - What to hit at rope drop/Early Entry
   - What to save for Lightning Lane

6. END OF NIGHT STRATEGY:
   - Remind them actual waits are 30-50% of posted!
   - LLSP often available late

7. IF PARK HOPPING:
   - After ONE scan, they can book any attraction at next park with NO tier restrictions!

Be specific about THIS park's tier structure and priorities. Give actionable advice, not generic tips.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: 'You are an expert Disney World Lightning Lane strategist. The Refresh Hack is the #1 strategy - always emphasize it. Give specific, actionable advice.',
      messages: [{ role: 'user', content: prompt }]
    });

    let content = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      }
    }

    res.json({ success: true, content });

  } catch (error) {
    console.error('Lightning Lane strategy error:', error);
    res.status(500).json({ error: 'Failed to generate Lightning Lane strategy' });
  }
});

// Generate Budget Breakdown
app.post('/api/generate/budget', authenticateToken, async (req, res) => {
  try {
    const { tripLength, partySize, accommodationLevel, diningStyle, extras } = req.body;

    const db = await connectDB();
    const users = db.collection('users');
    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
    const tripData = user?.tripData || {};

    const prompt = `Create a budget breakdown and money-saving tips for a Walt Disney World vacation:

TRIP DETAILS:
- Length: ${tripLength || '5 nights'}
- Party size: ${partySize || tripData.partySize || '4 guests'}
- Accommodation level: ${accommodationLevel || tripData.resort || 'Moderate resort'}
- Dining style: ${diningStyle || 'Mix of quick service and table service'}
- Extras considered: ${extras || 'Standard park tickets'}

Provide:
1. Estimated cost breakdown by category:
   - Accommodations
   - Park tickets
   - Food & dining
   - Lightning Lane/Genie+
   - Souvenirs
   - Transportation (if applicable)
   - Miscellaneous

2. Money-saving tips specific to their trip
3. Where to splurge vs. where to save
4. Free or low-cost activities they might not know about
5. Best value dining options
6. Discount opportunities to look for

Note: Provide ranges rather than exact prices since costs change. Focus on practical budgeting advice.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    let content = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      }
    }

    res.json({ success: true, content });

  } catch (error) {
    console.error('Budget generation error:', error);
    res.status(500).json({ error: 'Failed to generate budget breakdown' });
  }
});

// ============== SAVED CONTENT ==============

app.post('/api/content/save', authenticateToken, async (req, res) => {
  try {
    const { title, type, content } = req.body;

    const db = await connectDB();
    const savedContent = db.collection('savedContent');

    const newContent = {
      userId: new ObjectId(req.user.userId),
      title: title || 'Untitled',
      type: type || 'general',
      content,
      createdAt: new Date()
    };

    const result = await savedContent.insertOne(newContent);

    res.json({
      success: true,
      id: result.insertedId
    });

  } catch (error) {
    console.error('Save content error:', error);
    res.status(500).json({ error: 'Failed to save content' });
  }
});

app.get('/api/content', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const savedContent = db.collection('savedContent');

    const content = await savedContent
      .find({ userId: new ObjectId(req.user.userId) })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      success: true,
      savedContent: content.map(c => ({
        id: c._id.toString(),
        title: c.title,
        type: c.type,
        content: c.content,
        createdAt: c.createdAt
      }))
    });

  } catch (error) {
    console.error('Get content error:', error);
    res.status(500).json({ error: 'Failed to get content' });
  }
});

app.delete('/api/content/:id', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const savedContent = db.collection('savedContent');

    await savedContent.deleteOne({
      _id: new ObjectId(req.params.id),
      userId: new ObjectId(req.user.userId)
    });

    res.json({ success: true });

  } catch (error) {
    console.error('Delete content error:', error);
    res.status(500).json({ error: 'Failed to delete content' });
  }
});

// ============== ITINERARY CALENDAR ==============

app.get('/api/calendar', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const calendar = db.collection('calendar');

    const scheduled = await calendar
      .find({ userId: new ObjectId(req.user.userId) })
      .toArray();

    // Get associated content
    const savedContent = db.collection('savedContent');
    const enriched = await Promise.all(scheduled.map(async (item) => {
      let content = null;
      if (item.contentId) {
        content = await savedContent.findOne({ _id: new ObjectId(item.contentId) });
      }
      return {
        id: item._id.toString(),
        scheduledDate: item.scheduledDate,
        parkDay: item.parkDay,
        notes: item.notes,
        content: content ? {
          id: content._id.toString(),
          title: content.title,
          content: content.content
        } : null
      };
    }));

    res.json({
      success: true,
      scheduled: enriched
    });

  } catch (error) {
    console.error('Get calendar error:', error);
    res.status(500).json({ error: 'Failed to get calendar' });
  }
});

app.post('/api/calendar/schedule', authenticateToken, async (req, res) => {
  try {
    const { contentId, scheduledDate, parkDay, notes } = req.body;

    const db = await connectDB();
    const calendar = db.collection('calendar');

    const newEntry = {
      userId: new ObjectId(req.user.userId),
      contentId: contentId ? new ObjectId(contentId) : null,
      scheduledDate,
      parkDay: parkDay || '',
      notes: notes || '',
      createdAt: new Date()
    };

    const result = await calendar.insertOne(newEntry);

    res.json({
      success: true,
      id: result.insertedId
    });

  } catch (error) {
    console.error('Schedule content error:', error);
    res.status(500).json({ error: 'Failed to schedule content' });
  }
});

app.delete('/api/calendar/:id', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const calendar = db.collection('calendar');

    await calendar.deleteOne({
      _id: new ObjectId(req.params.id),
      userId: new ObjectId(req.user.userId)
    });

    res.json({ success: true });

  } catch (error) {
    console.error('Delete calendar entry error:', error);
    res.status(500).json({ error: 'Failed to delete calendar entry' });
  }
});

// ============== PLANNING CHECKLIST ==============

app.get('/api/checklist', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const users = db.collection('users');
    const checklists = db.collection('checklists');

    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
    const tripData = user?.tripData || {};

    // Get user's completed items
    const userChecklist = await checklists.findOne({ userId: new ObjectId(req.user.userId) });
    const completedItems = userChecklist?.completedItems || [];

    // Generate checklist based on trip data
    const checklistItems = generateChecklist(tripData);

    res.json({
      success: true,
      checklist: checklistItems.map(item => ({
        ...item,
        completed: completedItems.includes(item.id)
      }))
    });

  } catch (error) {
    console.error('Get checklist error:', error);
    res.status(500).json({ error: 'Failed to get checklist' });
  }
});

app.post('/api/checklist/toggle', authenticateToken, async (req, res) => {
  try {
    const { itemId, completed } = req.body;

    const db = await connectDB();
    const checklists = db.collection('checklists');

    if (completed) {
      await checklists.updateOne(
        { userId: new ObjectId(req.user.userId) },
        { $addToSet: { completedItems: itemId } },
        { upsert: true }
      );
    } else {
      await checklists.updateOne(
        { userId: new ObjectId(req.user.userId) },
        { $pull: { completedItems: itemId } }
      );
    }

    res.json({ success: true });

  } catch (error) {
    console.error('Toggle checklist error:', error);
    res.status(500).json({ error: 'Failed to update checklist' });
  }
});

// Helper function to generate planning checklist
function generateChecklist(tripData) {
  return [
    // Pre-Planning (6+ months out)
    { id: 'pre-1', title: 'Set your travel dates', description: 'Consider crowd calendars, special events, and weather', category: '6+ Months Out', priority: 'high' },
    { id: 'pre-2', title: 'Set your budget', description: 'Determine total budget for accommodations, tickets, food, and extras', category: '6+ Months Out', priority: 'high' },
    { id: 'pre-3', title: 'Book resort or hotel', description: 'Disney resorts, Good Neighbor hotels, or off-site options', category: '6+ Months Out', priority: 'high' },
    { id: 'pre-4', title: 'Purchase park tickets', description: 'Compare ticket options: base vs. Park Hopper vs. Park Hopper Plus', category: '6+ Months Out', priority: 'high' },
    
    // 60 Days Out
    { id: '60d-1', title: 'Make dining reservations', description: 'Book 60 days in advance at 6am ET (resort guests can book entire stay)', category: '60 Days Out', priority: 'high' },
    { id: '60d-2', title: 'Plan your park days', description: 'Decide which park to visit each day', category: '60 Days Out', priority: 'medium' },
    { id: '60d-3', title: 'Research Lightning Lane options', description: 'Learn which rides offer Individual LL vs. Multi Pass', category: '60 Days Out', priority: 'medium' },
    
    // 30 Days Out
    { id: '30d-1', title: 'Make park reservations', description: 'Required to enter the parks - book through My Disney Experience', category: '30 Days Out', priority: 'high' },
    { id: '30d-2', title: 'Download My Disney Experience app', description: 'Essential for reservations, mobile order, Lightning Lane, and more', category: '30 Days Out', priority: 'high' },
    { id: '30d-3', title: 'Link tickets and reservations', description: 'Make sure everything is linked in My Disney Experience', category: '30 Days Out', priority: 'high' },
    { id: '30d-4', title: 'Create daily itineraries', description: 'Plan your must-do attractions, shows, and character meets', category: '30 Days Out', priority: 'medium' },
    
    // 7 Days Out (Lightning Lane for resort guests)
    { id: '7d-1', title: 'Book Lightning Lane Multi-Pass (resort guests)', description: 'On-site guests can book at 7am ET, 7 days before first park day', category: '7 Days Out', priority: 'high' },
    { id: '7d-2', title: 'Review park hours and show times', description: 'Hours may have been updated since you booked', category: '7 Days Out', priority: 'medium' },
    
    // 2 Weeks Out
    { id: '2w-1', title: 'Check dining reservations', description: 'Confirm all reservations and look for hard-to-get openings', category: '2 Weeks Out', priority: 'medium' },
    { id: '2w-2', title: 'Start packing list', description: 'Begin gathering items you will need', category: '2 Weeks Out', priority: 'medium' },
    { id: '2w-3', title: 'Arrange transportation', description: 'Airport transfers, rental car, or Disney transportation', category: '2 Weeks Out', priority: 'medium' },
    
    // 1 Week Out
    { id: '1w-1', title: 'Online check-in (resort guests)', description: 'Complete online check-in for faster arrival', category: '1 Week Out', priority: 'medium' },
    { id: '1w-2', title: 'Finalize packing', description: 'Use a Disney-specific packing list', category: '1 Week Out', priority: 'medium' },
    { id: '1w-3', title: 'Charge portable batteries', description: 'Your phone will be essential in the parks', category: '1 Week Out', priority: 'low' },
    { id: '1w-4', title: 'Print important documents', description: 'Confirmation numbers, flight info, dining reservations', category: '1 Week Out', priority: 'low' },
    
    // 3 Days Out (Lightning Lane for off-site guests)
    { id: '3d-1', title: 'Book Lightning Lane Multi-Pass (off-site guests)', description: 'Off-site guests can book at 7am ET, 3 days before park day', category: '3 Days Out', priority: 'high' },
    
    // Day Before
    { id: 'db-1', title: 'Check weather forecast', description: 'Adjust packing if needed', category: 'Day Before', priority: 'medium' },
    { id: 'db-2', title: 'Confirm flight/travel times', description: 'Double-check departure times and set alarms', category: 'Day Before', priority: 'high' },
    { id: 'db-3', title: 'Pack park bags', description: 'Prepare what you will carry into the parks', category: 'Day Before', priority: 'medium' },
    { id: 'db-4', title: 'Review first day plan', description: 'Know your Lightning Lane strategy and dining for day one', category: 'Day Before', priority: 'medium' }
  ];
}

// ============== PROGRESS TRACKING ==============

app.get('/api/progress', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const users = db.collection('users');
    const checklists = db.collection('checklists');
    const savedContent = db.collection('savedContent');

    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
    const userChecklist = await checklists.findOne({ userId: new ObjectId(req.user.userId) });
    const contentCount = await savedContent.countDocuments({ userId: new ObjectId(req.user.userId) });

    const totalChecklistItems = generateChecklist({}).length;
    const completedItems = userChecklist?.completedItems?.length || 0;

    res.json({
      success: true,
      progress: {
        hasTripData: !!user?.tripData,
        checklistProgress: Math.round((completedItems / totalChecklistItems) * 100),
        completedTasks: completedItems,
        totalTasks: totalChecklistItems,
        savedPlans: contentCount
      }
    });

  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', message: 'WDW MVP API is running', date: getCurrentDate() });
});

// Start server
app.listen(port, () => {
  console.log('WDW MVP API running on port ' + port);
});

module.exports = app;
