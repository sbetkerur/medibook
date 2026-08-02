// Simple bilingual translation object for bot messages
// Add Hindi translations here as needed (en is always the default)
const messages = {
  welcome: {
    en: (name, clinic) => `👋 Welcome${name} to *${clinic}*!\n\nHow can I help you today?`,
  },
  mainMenuButtons: {
    en: ['📅 Book Appointment', '🗓 My Appointments', '📋 Check Status'],
  },
  bookAppointment: { en: '📅 Book Appointment' },
  myAppointments: { en: '🗓 My Appointments' },
  checkStatus: { en: '📋 Check Status' },
  helpText: {
    en: `ℹ️ *Help*\n\n• Reply *Book* — Book an appointment\n• Reply *Status* — View your appointments\n• Reply *Menu* — Return to main menu\n• Reply *Hi* — Start over / choose a different clinic\n\nFor emergencies, please call the clinic directly.`,
  },
  selectHospital: { en: '🦷 *Select a Clinic*\n\nChoose your preferred branch:' },
  selectVisitType: { en: '🦷 *Type of Visit*\n\nAll our consultations are in-clinic.' },
  visitTypeButtons: { en: ['🦷 In-Clinic Visit'] },
  selectSpecialty: { en: '🦷 *Select Treatment*\n\nWhat dental treatment do you need?' },
  noSpecialties: { en: 'No treatments available right now. Please contact the clinic directly.\n\nReply *Menu* to start over.' },
  selectDoctor: { en: '🦷 *Select Dentist*' },
  selectDate: (docName) => ({ en: `📅 *Select Date*\n\nAvailable dates for Dr. ${docName}:` }),
  noSlots: (docName) => ({ en: `No available slots for Dr. ${docName} in the next 14 days.\n\nPlease choose a different dentist or try again later.` }),
  selectSlot: (dateLabel) => ({ en: `⏰ *Select Time*\n\nSlots on ${dateLabel}:` }),
  yourName: { en: '👤 *Your Name*\n\nPlease enter your full name:' },
  yourDob: { en: '🎂 *Date of Birth*\n\nEnter your DOB in DD/MM/YYYY format:\nExample: 15/08/1990' },
  invalidDob: { en: 'Invalid format. Please use DD/MM/YYYY\nExample: 15/08/1990' },
  invalidDobDate: { en: 'Please enter a valid date in DD/MM/YYYY format.\nExample: 15/08/1990' },
  yourGender: { en: '👤 *Your Gender*' },
  genderButtons: { en: ['Male', 'Female', 'Other'] },
  confirmBooking: { en: ['✅ Confirm', '❌ Cancel'] },
  bookingCancelled: { en: 'Booking cancelled. Reply *Menu* to start over anytime. 👋' },
  slotTaken: { en: '⚠️ Sorry, that slot was just taken by someone else!\n\nReply *Menu* to choose another time.' },
  checkStatusPrompt: { en: '📋 *Check Appointment Status*\n\nPlease enter your Booking ID (e.g. MB12AB3):' },
  bookingNotFound: { en: 'Booking ID not found. Please check and try again.\n\nReply *Menu* to go back.' },
  feedbackPrompt: (docName) => ({ en: `⭐ *Appointment Feedback*\n\nHow was your experience with Dr. ${docName}?\n\nPlease rate from 1 to 5:` }),
  feedbackButtons: { en: ['⭐ 1', '⭐⭐ 2', '⭐⭐⭐ 3'] },
  feedbackButtons2: { en: ['⭐⭐⭐⭐ 4', '⭐⭐⭐⭐⭐ 5', '⏭️ Skip'] },
  feedbackCommentPrompt: { en: 'Thank you! Would you like to leave a comment? (Or reply *Skip* to finish)' },
  feedbackDone: { en: '✅ Thank you for your feedback! It helps us improve our service.\n\nReply *Menu* for the main menu.' },
  unknownInput: { en: 'Sorry, I didn\'t understand that. 🤔\n\nReply *Menu* to return to the main menu.' },
};

function t(key, lang = 'en', ...args) {
  const entry = messages[key];
  if (!entry) return key;
  if (typeof entry === 'function') {
    const result = entry(...args);
    return result[lang] || result['en'] || key;
  }
  return entry[lang] || entry['en'] || key;
}

module.exports = { t, messages };
