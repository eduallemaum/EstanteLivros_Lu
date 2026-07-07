import React from 'react';

interface BookCoverProps {
  title: string;
  author: string;
  genre: string;
  coverImage?: string;
  className?: string;
}

const PASTEL_THEMES = [
  { bg: 'from-amber-100 to-amber-200 text-amber-900 border-amber-300', accent: 'bg-amber-400' },
  { bg: 'from-rose-100 to-rose-200 text-rose-900 border-rose-300', accent: 'bg-rose-400' },
  { bg: 'from-purple-100 to-purple-200 text-purple-900 border-purple-300', accent: 'bg-purple-400' },
  { bg: 'from-sky-100 to-sky-200 text-sky-900 border-sky-300', accent: 'bg-sky-400' },
  { bg: 'from-emerald-100 to-emerald-200 text-emerald-900 border-emerald-300', accent: 'bg-emerald-400' },
  { bg: 'from-indigo-100 to-indigo-200 text-indigo-900 border-indigo-300', accent: 'bg-indigo-400' },
];

export const BookCover: React.FC<BookCoverProps> = ({ title, author, genre, coverImage, className = '' }) => {
  const [imgError, setImgError] = React.useState(false);

  // Simple stable hash function based on title
  const getHash = (str: string) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash);
  };

  const themeIndex = getHash(title || 'Sem Título') % PASTEL_THEMES.length;
  const theme = PASTEL_THEMES[themeIndex];

  if (coverImage && coverImage.startsWith('http') && !imgError) {
    // Replace http: with https: to prevent mixed content warnings
    const secureCoverUrl = coverImage.replace(/^http:/, 'https:');
    return (
      <div 
        id={`book-cover-${getHash(title)}`}
        className={`relative w-24 h-36 rounded-r-md shadow-md flex-shrink-0 overflow-hidden bg-slate-100 border-l-4 border-black/10 ${className}`}
      >
        <img
          src={secureCoverUrl}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className="w-full h-full object-cover transition-transform duration-300 hover:scale-105"
          alt={title}
        />
        {/* Book spine line shadow */}
        <div className="absolute top-0 left-0 w-1 h-full bg-black/10 rounded-r-sm pointer-events-none" />
        <div className="absolute top-0 left-2 w-px h-full bg-white/20 pointer-events-none" />
      </div>
    );
  }

  return (
    <div
      id={`book-cover-${getHash(title)}`}
      className={`relative w-24 h-36 rounded-r-md shadow-md flex-shrink-0 flex flex-col justify-between p-3 border-l-4 border-black/10 select-none bg-gradient-to-br ${theme.bg} ${className}`}
    >
      {/* Book spine line shadow */}
      <div className="absolute top-0 left-0 w-1 h-full bg-black/5 rounded-r-sm" />
      <div className="absolute top-0 left-2 w-px h-full bg-white/30" />

      {/* Genre mini banner */}
      <div className="text-[9px] uppercase tracking-wider font-semibold opacity-70 truncate">
        {genre || 'Literatura'}
      </div>

      {/* Book Title & Author */}
      <div className="flex-1 flex flex-col justify-center my-1">
        <h4 className="font-serif text-xs font-bold leading-tight line-clamp-3 text-center mb-1">
          {title || 'Título'}
        </h4>
        <p className="text-[10px] opacity-80 text-center italic truncate">
          {author || 'Autor'}
        </p>
      </div>

      {/* Elegant design ornament */}
      <div className="flex justify-center items-center mt-auto">
        <div className={`w-3 h-3 rounded-full ${theme.accent} opacity-60`} />
      </div>
    </div>
  );
};
