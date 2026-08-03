import LegalDocument from '@/components/LegalDocument';
import { getLegalDoc } from '@/lib/legalDoc';

export const metadata = {
  title: 'Terms of Service — MediBook',
  description: 'The agreement between MediBook and subscribing dental clinics.',
};

export default function TermsPage() {
  return <LegalDocument doc={getLegalDoc('terms')} />;
}
