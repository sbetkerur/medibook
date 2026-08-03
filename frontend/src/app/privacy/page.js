import LegalDocument from '@/components/LegalDocument';
import { getLegalDoc } from '@/lib/legalDoc';

export const metadata = {
  title: 'Privacy Policy — MediBook',
  description: 'How MediBook handles personal data under the DPDP Act, 2023.',
};

export default function PrivacyPage() {
  return <LegalDocument doc={getLegalDoc('privacy')} />;
}
