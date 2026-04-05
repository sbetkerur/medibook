'use client';
import { useEffect } from 'react';

export default function ConfirmModal({ title, message, onConfirm, onCancel, danger = false }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onCancel(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5"
      >
        <h3 id="confirm-modal-title" className="text-base font-semibold text-gray-900 mb-2">{title}</h3>
        <p id="confirm-modal-message" className="text-sm text-gray-600 mb-5">{message}</p>
        <div className="flex gap-3">
          <button onClick={onCancel}
            className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">
            Cancel
          </button>
          <button onClick={onConfirm}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-white transition ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
