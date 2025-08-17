require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

/** --- MongoDB / Mongoose setup --- **/
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error', err));

/** --- Schemas --- **/
const UserSchema = new mongoose.Schema({
  androidId: { type: String, unique: true, required: true },
  deviceName: { type: String, required: true },
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
  createdAt: { type: Date, default: Date.now }
});

const GroupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  joinCode: { type: String, unique: true, index: true },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  joinRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});
const ExpenseSchema = new mongoose.Schema({
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  description: String,
  amount: { type: Number, required: true },
  approvals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  approved: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Group = mongoose.model('Group', GroupSchema);
const Expense = mongoose.model('Expense', ExpenseSchema);

const ContactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  message: { type: String, required: true },
  plan: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
})

const TestimonialSchema = new mongoose.Schema({
  name: { type: String, required: true },
  title: { type: String, required: true },
  company: { type: String },
  image: { type: String },
  testimonial: { type: String, required: true },
  verified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
})

const Contact = mongoose.model('Contact', ContactSchema);
const Testimonial = mongoose.model('Testimonial', TestimonialSchema);



/** --- Helper: approval threshold (>50%) --- **/
function approvalThreshold(memberCount) {
  return Math.floor(memberCount / 2) + 1;
}

/** --- REST Routes --- **/

// POST /contact - Add new contact
app.post('/contact', async (req, res) => {
  try {
    const newContact = new Contact(req.body);
    const saved = await newContact.save();
    res.status(200).json({ success: true, id: saved._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /testimonial - Add new testimonial
app.post('/testimonial', async (req, res) => {
  try {
    const newTestimonial = new Testimonial(req.body);
    const saved = await newTestimonial.save();
    res.status(200).json({ success: true, id: saved._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /testimonial - Get all testimonials
app.get('/testimonial', async (req, res) => {
  try {
    const testimonials = await Testimonial.find({ verified: true }).sort({ createdAt: -1 });
    res.status(200).json(testimonials);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login or auto-create user
app.post('/users/login', async (req, res) => {
  try {
    const { androidId, deviceName } = req.body;
    if (!androidId) return res.status(400).json({ message: 'androidId required' });

    let user = await User.findOne({ androidId });

    if (!user) {
      user = await User.create({ androidId, deviceName });
    } else {
      // Optionally update deviceName if it changed
      if (deviceName && user.deviceName !== deviceName) {
        user.deviceName = deviceName;
        await user.save();
      }
    }

    res.json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});



// Create group
app.post('/groups', async (req, res) => {
  try {
    console.log('Creating group with body:', req.body);
    const { name, userId } = req.body;
    if (!name || !userId) {
      return res.status(400).json({ message: 'Missing group name or userId' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const joinCode = uuidv4().slice(0, 8).toUpperCase();
    const group = new Group({ name, joinCode, creator: user._id, members: [user._id] });
    await group.save();

    user.groupId = group._id;
    await user.save();

    const populated = await Group.findById(group._id).populate('members').lean();
    return res.json({ group: populated, user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});


// Join group (creates user & adds join request)
app.post('/groups/join', async (req, res) => {
  try {
    console.log('Join group request with body:', req.body);
    const { joinCode, userId } = req.body;
    if (!joinCode || !userId) {
      return res.status(400).json({ message: 'Missing joinCode or userId' });
    }

    const group = await Group.findOne({ joinCode });
    if (!group) return res.status(404).json({ message: 'Group not found' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Only add to joinRequests if not already in group
    if (!group.members.includes(user._id) && !group.joinRequests.includes(user._id)) {
      group.joinRequests.push(user._id);
      await group.save();
    }
    console.log(group)

    return res.json({ message: 'Join request sent', user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Approve join request
app.post('/groups/approve-join', async (req, res) => {
  try {
    const { groupId, userId } = req.body;
    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: 'Group not found' });

    if (!group.members.includes(userId)) {
      group.members.push(userId);
    }
    group.joinRequests = group.joinRequests.filter(u => String(u) !== String(userId));
    await group.save();

    const user = await User.findById(userId);
    return res.json({ message: 'User added to members', user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get group details
app.get('/groups/:id', async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
      .populate('members', 'deviceName')
      .populate('joinRequests', 'deviceName')
      .lean();
      console.log(group)
    if (!group) return res.status(404).json({ message: 'Group not found' });

    const expenses = await Expense.find({ groupId: group._id }).populate('addedBy', 'deviceName').lean();

    return res.json({ ...group, expenses });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Add expense
app.post('/expenses', async (req, res) => {
  try {
    const { groupId, addedBy, description, amount } = req.body;
    if (!groupId || !addedBy || !amount) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const expense = new Expense({
      groupId,
      addedBy,
      description: description || '',
      amount: Number(amount),
      approvals: [],
      approved: false
    });
    await expense.save();

    const populated = await Expense.findById(expense._id).populate('addedBy', 'name').lean();
    return res.json({ expense: populated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Approve expense
app.post('/expenses/approve', async (req, res) => {
  try {
    const { expenseId, userId } = req.body;
    if (!expenseId || !userId) {
      return res.status(400).json({ message: 'Missing expenseId or userId' });
    }

    const expense = await Expense.findById(expenseId);
    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    if (!expense.approvals.map(String).includes(String(userId))) {
      expense.approvals.push(userId);
    }

    const group = await Group.findById(expense.groupId);
    const threshold = approvalThreshold(group.members.length);

    if (expense.approvals.length >= threshold) {
      expense.approved = true;
    }

    await expense.save();
    const populated = await Expense.findById(expense._id).populate('addedBy', 'name').lean();
    return res.json({ expense: populated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});


// Groups by user
app.get('/groups', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const groups = await Group.find({
      members: userId,
    }).sort({ updatedAt: -1 }).lean();

    // For each group, fetch expenses and add them as a field
    const groupsWithExpenses = await Promise.all(groups.map(async (group) => {
      const expenses = await Expense.find({ groupId: group._id })
        .populate('addedBy', 'name')
        .lean();
      return {
        ...group,
        expenses,
      };
    }));

    res.json(groupsWithExpenses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** --- Start server --- **/
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 REST API server running on port ${PORT}`);
});
