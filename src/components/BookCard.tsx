import React, { useState } from 'react';
import { Book } from '../types';
import { BookCover } from './BookCover';
import { Edit2, Trash2, BookOpen, Clock, CheckCircle, ChevronDown, ChevronUp } from 'lucide-react';

interface BookCardProps {
  book: Book;
  onEdit: (book: Book) => void;
  onDelete: (id: string) => void;
}

export const BookCard: React.FC<BookCardProps> = ({ book, onEdit, onDelete }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const getStatusBadge = (status: Book['status']) => {
    switch (status) {
      case 'Lendo':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-bento-lavender text-bento-primary border border-bento-purple/30">
            <Clock className="w-3 h-3 text-bento-primary animate-pulse" />
            Lendo
          </span>
        );
      case 'Lido':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-bento-sage/40">
            <CheckCircle className="w-3 h-3 text-emerald-600" />
            Lido
          </span>
        );
      case 'Quero Ler':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200/50">
            <BookOpen className="w-3 h-3 text-amber-600" />
            Quero Ler
          </span>
        );
    }
  };

  return (
    <div
      id={`book-card-${book.id}`}
      className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 hover:shadow-md transition-shadow duration-300 flex flex-col gap-4 relative overflow-hidden"
    >
      {/* Visual background gradient accent */}
      <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-bl from-bento-lavender/30 via-transparent to-transparent rounded-tr-2xl -z-10 pointer-events-none" />

      <div className="flex gap-4 items-start">
        {/* Cover */}
        <BookCover title={book.title} author={book.author} genre={book.genre} coverImage={book.coverImage} />

        {/* Info */}
        <div className="flex-1 min-w-0 flex flex-col justify-between h-36">
          <div>
            <div className="flex items-start justify-between gap-1">
              <h3 className="font-sans font-bold text-slate-800 text-base leading-snug line-clamp-2">
                {book.title}
              </h3>
            </div>
            <p className="text-sm text-slate-500 font-medium truncate mt-0.5">
              por {book.author}
            </p>

            <div className="flex flex-wrap gap-1.5 mt-2">
              <span className="text-xs px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 font-medium">
                {book.genre || 'Sem Gênero'}
              </span>
              {book.pages > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 font-medium">
                  {book.pages} pág.
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between mt-auto">
            {getStatusBadge(book.status)}

            {/* Actions */}
            <div className="flex gap-1.5">
              <button
                id={`edit-btn-${book.id}`}
                onClick={() => onEdit(book)}
                className="p-1.5 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors"
                title="Editar Livro"
              >
                <Edit2 className="w-4 h-4" />
              </button>
              <button
                id={`delete-btn-${book.id}`}
                onClick={() => book.id && onDelete(book.id)}
                className="p-1.5 rounded-xl hover:bg-rose-50 text-slate-400 hover:text-rose-600 transition-colors"
                title="Excluir Livro"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Synopsis Accordion */}
      {book.synopsis && (
        <div className="border-t border-slate-50 pt-3">
          <button
            id={`synopsis-toggle-${book.id}`}
            onClick={() => setIsExpanded(!isExpanded)}
            className="w-full flex items-center justify-between text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors py-1"
          >
            <span>Sinopse</span>
            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          {isExpanded && (
            <p className="text-xs text-slate-600 mt-2 leading-relaxed text-justify bg-slate-50/50 p-2.5 rounded-xl border border-slate-50">
              {book.synopsis}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
