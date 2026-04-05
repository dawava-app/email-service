const express = require('express');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const { sendEmailDirect, bulkTemplatedSend, bulkTemplatedSendSheet } = require('../controllers/emailController');
const { requireServiceAuth } = require('../middlewares/serviceAuth');
const { validateEmailRequest, ensureUniqueEmailRequest } = require('../middlewares/emailRequest');

const router = express.Router();

router.use(requireServiceAuth);
router.post('/send', validateEmailRequest, ensureUniqueEmailRequest, sendEmailDirect);
router.post('/bulk-template', bulkTemplatedSend);
router.post('/bulk-template-sheet', upload.single('sheet'), bulkTemplatedSendSheet);

module.exports = router;
