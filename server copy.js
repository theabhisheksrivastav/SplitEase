// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid'); // optional if you want UUIDs for join codes

const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server + socket.io
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: '*' } // adjust origin for production
});

/** --- MongoDB / Mongoose setup --- **/
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error', err));

// Schemas
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  createdAt: { type: Date, default: Date.now }
});
const GroupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // optional at creation time
  joinCode: { type: String, unique: true, index: true }, // for invite link/code
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

/** --- Helper: approval threshold (>50%) --- **/
function approvalThreshold(memberCount) {
  // More than 50% required. For N members, need floor(N/2)+1
  return Math.floor(memberCount / 2) + 1;
}

/** --- REST Routes --- **/

// Create group
// body: { name, creatorName } -> creates group, creates creator user, adds to members
app.post('/groups', async (req, res) => {
  try {
    const { name, creatorName } = req.body;
    if (!name || !creatorName) return res.status(400).json({ message: 'Missing name or creatorName' });

    // create group with unique joinCode
    const joinCode = (uuidv4()).slice(0, 8).toUpperCase();
    const group = new Group({ name, joinCode });
    await group.save();

    // create creator user
    const creator = new User({ name: creatorName, groupId: group._id });
    await creator.save();

    // set creator and members
    group.creator = creator._id;
    group.members = [creator._id];
    await group.save();

    const populated = await Group.findById(group._id).populate('members').lean();
    return res.json({ group: populated, user: creator });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Join group -> Add a join request (creates a user doc with groupId)
// body: { joinCode, name } -> returns userId and marks joinRequest
app.post('/groups/join', async (req, res) => {
  try {
    const { joinCode, name } = req.body;
    if (!joinCode || !name) return res.status(400).json({ message: 'Missing joinCode or name' });

    const group = await Group.findOne({ joinCode });
    if (!group) return res.status(404).json({ message: 'Group not found' });

    // create user doc (not yet member)
    const user = new User({ name, groupId: group._id });
    await user.save();

    // add to joinRequests
    group.joinRequests.push(user._id);
    await group.save();

    // emit to group's room that there's a join request (creator / members can listen)
    io.to(String(group._id)).emit('joinRequest', { groupId: group._id, user: { id: user._id, name: user.name } });

    return res.json({ message: 'Join request sent', user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Approve join request (only creator should call this in frontend)
// body: { groupId, userId } (requester)
app.post('/groups/approve-join', async (req, res) => {
  try {
    const { groupId, userId } = req.body;
    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: 'Group not found' });

    // add to members if not already
    if (!group.members.includes(userId)) {
      group.members.push(userId);
    }
    // remove from joinRequests
    group.joinRequests = group.joinRequests.filter(u => String(u) !== String(userId));
    await group.save();

    const user = await User.findById(userId);
    // notify via socket
    io.to(String(group._id)).emit('memberApproved', { groupId: group._id, user: { id: user._id, name: user.name } });

    return res.json({ message: 'User added to members', user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get group details (members, joinRequests, expenses)
app.get('/groups/:id', async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
      .populate('members', 'name')
      .populate('joinRequests', 'name')
      .lean();
    if (!group) return res.status(404).json({ message: 'Group not found' });

    const expenses = await Expense.find({ groupId: group._id }).populate('addedBy', 'name').lean();
    return res.json({ ...group, expenses });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});

/** --- Socket.IO: real-time events --- **/
io.on('connection', (socket) => {
  console.log('Socket connected', socket.id);

  // Join room for a group to receive events
  // payload: { groupId, userId }
  socket.on('joinRoom', (payload) => {
    const { groupId, userId } = payload || {};
    if (!groupId) return;
    socket.join(String(groupId));
    console.log(`Socket ${socket.id} joined room ${groupId}`);
  });

  // Add expense via socket
  // payload: { groupId, addedBy (userId), description, amount }
  socket.on('addExpense', async (payload) => {
    try {
      const { groupId, addedBy, description, amount } = payload;
      if (!groupId || !addedBy || !amount) return;

      const expense = new Expense({
        groupId,
        addedBy,
        description: description || '',
        amount: Number(amount),
        approvals: [],
        approved: false
      });
      await expense.save();

      // populate for broadcast
      const populated = await Expense.findById(expense._id).populate('addedBy', 'name').lean();

      // emit to group room
      io.to(String(groupId)).emit('expenseAdded', { expense: populated });
    } catch (err) {
      console.error('addExpense error:', err);
      socket.emit('error', { message: 'Could not add expense' });
    }
  });

  // Approve expense via socket
  // payload: { expenseId, userId }
  socket.on('approveExpense', async (payload) => {
    try {
      const { expenseId, userId } = payload;
      if (!expenseId || !userId) return;

      const expense = await Expense.findById(expenseId);
      if (!expense) return socket.emit('error', { message: 'Expense not found' });

      // ensure user hasn't already approved
      if (expense.approvals.map(String).includes(String(userId))) {
        return; // ignore duplicate approval
      }

      expense.approvals.push(userId);

      // get member count of the group at time of approval
      const group = await Group.findById(expense.groupId);
      const membersCount = group.members.length;
      const threshold = approvalThreshold(membersCount); // more than 50%

      // set approved if approvals >= threshold
      if (expense.approvals.length >= threshold) {
        expense.approved = true;
      }

      await expense.save();

      // send updated expense to group
      const populated = await Expense.findById(expense._id).populate('addedBy', 'name').lean();
      io.to(String(expense.groupId)).emit('expenseUpdated', { expense: populated });
      if (populated.approved) {
        io.to(String(expense.groupId)).emit('expenseApproved', { expense: populated });
      }

    } catch (err) {
      console.error('approveExpense error:', err);
      socket.emit('error', { message: 'Could not approve expense' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected', socket.id);
  });
});

/** --- Start server --- **/
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});


// // server.js
// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const mongoose = require('mongoose');
// const { v4: uuidv4 } = require('uuid');

// const app = express();
// app.use(cors());
// app.use(express.json());

// // MongoDB Connection
// mongoose.connect(process.env.MONGO_URI, {
//     useNewUrlParser: true,
//     useUnifiedTopology: true
// }).then(() => console.log("✅ MongoDB Connected"))
//   .catch(err => console.error("❌ MongoDB Error:", err));

// // Schemas
// const GroupSchema = new mongoose.Schema({
//     name: String,
//     creator: String,
//     startDate: String,
//     endDate: String,
//     members: [String],
//     joinRequests: [String]
// });

// const ExpenseSchema = new mongoose.Schema({
//     groupId: String,
//     description: String,
//     amount: Number,
//     paidBy: String
// });

// const Group = mongoose.model('Group', GroupSchema);
// const Expense = mongoose.model('Expense', ExpenseSchema);

// // Routes

// // Create group
// app.post('/groups', async (req, res) => {
//     const { name, creator, startDate, endDate } = req.body;
//     const group = new Group({
//         name,
//         creator,
//         startDate,
//         endDate,
//         members: [creator],
//         joinRequests: []
//     });
//     await group.save();
//     res.json(group);
// });

// // Request to join group
// app.post('/groups/:id/join', async (req, res) => {
//     const { user } = req.body;
//     const group = await Group.findById(req.params.id);
//     if (!group) return res.status(404).json({ message: 'Group not found' });

//     if (!group.joinRequests.includes(user)) {
//         group.joinRequests.push(user);
//         await group.save();
//     }
//     res.json({ message: 'Join request sent' });
// });

// // Approve join request
// app.post('/groups/:id/approve', async (req, res) => {
//     const { user } = req.body;
//     const group = await Group.findById(req.params.id);
//     if (!group) return res.status(404).json({ message: 'Group not found' });

//     if (!group.members.includes(user)) {
//         group.members.push(user);
//     }
//     group.joinRequests = group.joinRequests.filter(u => u !== user);
//     await group.save();
//     res.json({ message: 'User added' });
// });

// // Add expense
// app.post('/expenses', async (req, res) => {
//     const { groupId, description, amount, paidBy } = req.body;
//     const expense = new Expense({ groupId, description, amount, paidBy });
//     await expense.save();
//     res.json(expense);
// });

// // Get group details + expenses
// app.get('/groups/:id', async (req, res) => {
//     const group = await Group.findById(req.params.id);
//     if (!group) return res.status(404).json({ message: 'Group not found' });

//     const groupExpenses = await Expense.find({ groupId: group.id });
//     res.json({ ...group.toObject(), expenses: groupExpenses });
// });

// // Start server
// app.listen(process.env.PORT, () => {
//     console.log(`🚀 Backend running on port ${process.env.PORT}`);
// });
