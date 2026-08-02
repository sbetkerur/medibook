import './globals.css';
import { Toaster } from 'react-hot-toast';
import ErrorBoundary from '@/components/ErrorBoundary';

export const metadata = {
  title: 'MediBook — WhatsApp Appointment System',
  description: 'Multi-tenant WhatsApp appointment booking for clinics and hospitals',
};

// Declared explicitly rather than relying on Next's implicit default, so the
// responsive layouts below can never be defeated by a 980px fallback viewport.
// `maximumScale` is deliberately NOT set — clinic staff must be able to pinch
// zoom a patient's phone number or a booking ID.
export const viewport = {
  width: 'device-width',
  initialScale: 1,
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
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
