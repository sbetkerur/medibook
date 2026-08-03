import LegalDocument from '@/components/LegalDocument';
import { getLegalDoc } from '@/lib/legalDoc';

export const metadata = {
  title: 'Data Processing Agreement — MediBook',
  description: 'The DPDP Act s.8(2) contract between a clinic and MediBook.',
};

export default function DpaPage() {
  return <LegalDocument doc={getLegalDoc('dpa')} />;
}
