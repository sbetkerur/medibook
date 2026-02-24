import './globals.css';
import { Toaster } from 'react-hot-toast';

export const metadata = {
  title: 'MediBook — WhatsApp Appointment System',
  description: 'Multi-tenant WhatsApp appointment booking for clinics and hospitals',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: { fontSize: '14px' },
          }}
        />
        {children}
      </body>
    </html>
  );
}
