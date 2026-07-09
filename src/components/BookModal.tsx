import React, { useState, useEffect } from 'react';
import { Book } from '../types';
import { X, Sparkles, AlertCircle, Loader2, Search } from 'lucide-react';

interface BookModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (book: Omit<Book, 'id'> & { id?: string }) => void;
  bookToEdit?: Book | null;
  isAiGenerated?: boolean;
}

export const BookModal: React.FC<BookModalProps> = ({
  isOpen,
  onClose,
  onSave,
  bookToEdit,
  isAiGenerated = false,
}) => {
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [genre, setGenre] = useState('');
  const [pages, setPages] = useState<number | string>('');
  const [synopsis, setSynopsis] = useState('');
  const [status, setStatus] = useState<Book['status']>('Quero Ler');
  const [coverImage, setCoverImage] = useState('');
  const [isSearchingCover, setIsSearchingCover] = useState(false);
  const [error, setError] = useState('');
  
  // AI Auto-Prefill States
  const [aiQuery, setAiQuery] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiCandidates, setAiCandidates] = useState<any[]>([]);

  useEffect(() => {
    if (bookToEdit) {
      setTitle(bookToEdit.title || '');
      setAuthor(bookToEdit.author || '');
      setGenre(bookToEdit.genre || '');
      setPages(bookToEdit.pages || '');
      setSynopsis(bookToEdit.synopsis || '');
      setStatus(bookToEdit.status || 'Quero Ler');
      setCoverImage(bookToEdit.coverImage || '');
    } else {
      setTitle('');
      setAuthor('');
      setGenre('');
      setPages('');
      setSynopsis('');
      setStatus('Quero Ler');
      setCoverImage('');
    }
    setError('');
    setAiQuery('');
    setAiCandidates([]);
    setIsAiLoading(false);
  }, [bookToEdit, isOpen]);

  if (!isOpen) return null;

  const handleFetchCover = async () => {
    if (!title.trim()) {
      setError('Insira o título do livro para buscar a capa.');
      return;
    }
    setIsSearchingCover(true);
    setError('');
    try {
      const q = encodeURIComponent(`intitle:${title.trim()}${author.trim() ? ` inauthor:${author.trim()}` : ''}`);
      const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1`);
      if (res.ok) {
        const data = await res.json();
        if (data.items && data.items.length > 0) {
          const thumbnail = data.items[0].volumeInfo?.imageLinks?.thumbnail;
          if (thumbnail) {
            setCoverImage(thumbnail.replace(/^http:/, 'https:'));
          } else {
            setError('Capa não encontrada no Google Books. Você pode colar um link manualmente abaixo.');
          }
        } else {
          setError('Nenhum livro correspondente encontrado para buscar a capa.');
        }
      } else {
        setError('Erro ao conectar ao Google Books.');
      }
    } catch (err) {
      setError('Falha ao buscar capa.');
    } finally {
      setIsSearchingCover(false);
    }
  };

  const handleAiPrefill = async () => {
    if (!aiQuery.trim()) {
      setError('Por favor, digite um ISBN ou o título do livro para preencher.');
      return;
    }
    setIsAiLoading(true);
    setError('');
    setAiCandidates([]);
    try {
      const response = await fetch('/api/book-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: aiQuery.trim() }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Não foi possível buscar as informações do livro.');
      }

      const data = await response.json();
      if (data && data.books && data.books.length > 0) {
        setAiCandidates(data.books);
      } else {
        throw new Error('Nenhuma edição correspondente foi localizada pelo assistente IA.');
      }
    } catch (err: any) {
      setError(err.message || 'Falha ao buscar dados do livro via IA.');
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleSelectCandidate = async (book: any) => {
    setTitle(book.title || '');
    setAuthor(book.author || '');
    setGenre(book.genre || '');
    setPages(book.pages || '');
    setSynopsis(book.synopsis || '');
    setStatus(book.status || 'Quero Ler');
    setAiCandidates([]); // clear the candidates list after selecting

    // Tenta buscar a capa do livro baseado no título e autor selecionados
    try {
      const q = encodeURIComponent(`intitle:${book.title}${book.author ? ` inauthor:${book.author}` : ''}`);
      const resCover = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1`);
      if (resCover.ok) {
        const dataCover = await resCover.json();
        if (dataCover.items && dataCover.items.length > 0) {
          const thumbnail = dataCover.items[0].volumeInfo?.imageLinks?.thumbnail;
          if (thumbnail) {
            setCoverImage(thumbnail.replace(/^http:/, 'https:'));
          }
        }
      }
    } catch (coverErr) {
      console.warn('Erro ao buscar capa após seleção da edição:', coverErr);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('O título do livro é obrigatório.');
      return;
    }
    if (!author.trim()) {
      setError('O autor do livro é obrigatório.');
      return;
    }

    onSave({
      id: bookToEdit?.id,
      title: title.trim(),
      author: author.trim(),
      genre: genre.trim() || 'Não classificado',
      pages: Number(pages) || 0,
      synopsis: synopsis.trim(),
      status,
      coverImage: coverImage.trim(),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-sm transition-opacity">
      <div
        id="book-form-modal"
        className="bg-white w-full sm:max-w-md md:max-w-lg rounded-t-3xl sm:rounded-2xl shadow-xl flex flex-col max-h-[92vh] sm:max-h-[85vh] overflow-hidden animate-in slide-in-from-bottom duration-300"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            {isAiGenerated && (
              <div className="p-1 bg-amber-50 text-amber-600 rounded-lg">
                <Sparkles className="w-4 h-4 animate-pulse" />
              </div>
            )}
            <h2 className="font-sans font-bold text-slate-800 text-lg">
              {bookToEdit?.id
                ? 'Editar Detalhes'
                : isAiGenerated
                ? 'Revisar Livro Detectado'
                : 'Adicionar Livro'}
            </h2>
          </div>
          <button
            id="close-modal-btn"
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
          {isAiGenerated && (
            <div className="bg-amber-50/70 border border-amber-100 p-3 rounded-2xl flex gap-2 items-start text-xs text-amber-800">
              <Sparkles className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Detectado por Inteligência Artificial</p>
                <p className="opacity-90 mt-0.5">Revise e complete as informações antes de salvar na estante.</p>
              </div>
            </div>
          )}

          {error && (
            <div className="bg-rose-50 border border-rose-100 text-rose-800 p-3 rounded-2xl flex gap-2 items-center text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
              <span>{error}</span>
            </div>
          )}

          {/* AI Auto-Prefill Magic Section */}
          {!bookToEdit?.id && (
            <div className="bg-gradient-to-br from-indigo-50 to-violet-50/50 border border-indigo-100 p-5 rounded-2xl space-y-3 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-indigo-950 text-xs font-extrabold uppercase tracking-wider">
                  <Sparkles className="w-4 h-4 text-indigo-500 animate-pulse" />
                  <span>Pesquisar Obra com IA</span>
                </div>
                <span className="text-[9px] font-bold bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full uppercase tracking-wider animate-pulse">
                  Recomendado
                </span>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed font-medium">
                Digite o número do <strong>ISBN</strong> ou o <strong>título da obra</strong> (com ou sem autor) e clique em <strong>Pesquisar</strong> para listar e selecionar edições disponíveis.
              </p>
              
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-indigo-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="input-ai-prefill-query"
                    type="text"
                    placeholder="Ex: 9788575226315 ou O Nome da Rosa"
                    value={aiQuery}
                    onChange={(e) => setAiQuery(e.target.value)}
                    className="w-full pl-9 pr-3.5 py-2.5 rounded-xl border border-indigo-150 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 text-xs text-slate-850 transition-all placeholder:text-slate-400 font-medium bg-white"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAiPrefill();
                      }
                    }}
                  />
                </div>
                <button
                  id="btn-ai-prefill-submit"
                  type="button"
                  onClick={handleAiPrefill}
                  disabled={isAiLoading}
                  className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white rounded-xl text-xs font-bold transition-all shrink-0 flex items-center justify-center gap-1.5 shadow-sm hover:shadow active:scale-95 disabled:pointer-events-none"
                >
                  {isAiLoading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Pesquisando...</span>
                    </>
                  ) : (
                    <>
                      <Search className="w-3.5 h-3.5" />
                      <span>Pesquisar</span>
                    </>
                  )}
                </button>
              </div>

              {/* Candidates selection */}
              {aiCandidates.length > 0 && (
                <div className="mt-4 space-y-2.5 border-t border-indigo-150/50 pt-3.5">
                  <div className="text-[11px] font-bold text-indigo-950 uppercase tracking-wider flex items-center gap-1">
                    <span>💡 Clique na edição desejada para preencher:</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto pr-1">
                    {aiCandidates.map((book, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => handleSelectCandidate(book)}
                        className="w-full text-left p-3 rounded-xl border border-indigo-100 hover:border-indigo-300 bg-white hover:bg-indigo-50/20 transition-all focus:outline-none flex flex-col justify-between shadow-sm hover:shadow group active:scale-[0.99]"
                      >
                        <div className="flex justify-between items-start w-full gap-2">
                          <span className="font-bold text-slate-800 text-xs group-hover:text-indigo-700 transition-colors">
                            {book.title}
                          </span>
                          {book.isbn && (
                            <span className="text-[9px] font-mono bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded shrink-0">
                              ISBN: {book.isbn}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          de {book.author}
                        </div>
                        {book.editionInfo && (
                          <div className="text-[10px] text-indigo-600 mt-1.5 font-semibold italic">
                            {book.editionInfo}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Título do Livro *</label>
            <input
              id="input-book-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ex: O Pequeno Príncipe"
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-bento-primary/20 focus:border-bento-primary text-sm text-slate-800 transition-all placeholder:text-slate-400 font-medium"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Autor(a) *</label>
            <input
              id="input-book-author"
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Ex: Antoine de Saint-Exupéry"
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-bento-primary/20 focus:border-bento-primary text-sm text-slate-800 transition-all placeholder:text-slate-400 font-medium"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider block">Capa do Livro (URL ou busca automática)</label>
            <div className="flex gap-2">
              <input
                id="input-book-cover"
                type="url"
                value={coverImage}
                onChange={(e) => setCoverImage(e.target.value)}
                placeholder="Cole o link da imagem da capa"
                className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-bento-primary/20 focus:border-bento-primary text-sm text-slate-800 transition-all placeholder:text-slate-400 font-medium"
              />
              <button
                id="btn-fetch-cover"
                type="button"
                onClick={handleFetchCover}
                disabled={isSearchingCover}
                className="px-4 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 rounded-xl text-xs font-bold transition-all border border-slate-200 shrink-0 flex items-center justify-center gap-1"
              >
                {isSearchingCover ? 'Buscando...' : 'Buscar Capa'}
              </button>
            </div>
            {coverImage && (
              <div className="mt-3 flex items-center gap-3 p-3 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="w-12 h-16 rounded-md shadow-sm overflow-hidden bg-white shrink-0 border border-slate-200">
                  <img 
                    src={coverImage} 
                    referrerPolicy="no-referrer" 
                    className="w-full h-full object-cover" 
                    alt="Preview da capa" 
                  />
                </div>
                <div className="text-xs text-slate-500">
                  <p className="font-semibold text-slate-700">Pré-visualização da capa</p>
                  <p className="line-clamp-1 break-all text-[10px] opacity-80">{coverImage}</p>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Gênero</label>
              <input
                id="input-book-genre"
                type="text"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                placeholder="Ex: Fantasia, Drama"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-bento-primary/20 focus:border-bento-primary text-sm text-slate-800 transition-all placeholder:text-slate-400 font-medium"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Páginas</label>
              <input
                id="input-book-pages"
                type="number"
                value={pages}
                onChange={(e) => setPages(e.target.value)}
                placeholder="Ex: 160"
                min="0"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-bento-primary/20 focus:border-bento-primary text-sm text-slate-800 transition-all placeholder:text-slate-400 font-medium"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider block">Status de Leitura</label>
            <div className="grid grid-cols-3 gap-2">
              {(['Quero Ler', 'Lendo', 'Lido'] as Book['status'][]).map((s) => (
                <button
                  key={s}
                  id={`status-select-${s.replace(' ', '-')}`}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`py-2 rounded-xl text-xs font-semibold border transition-all ${
                    status === s
                      ? s === 'Quero Ler'
                        ? 'bg-amber-500/10 text-amber-800 border-amber-300 ring-2 ring-amber-500/20'
                        : s === 'Lendo'
                        ? 'bg-bento-primary/10 text-bento-primary border-bento-purple/40 ring-2 ring-bento-primary/20'
                        : 'bg-emerald-500/10 text-emerald-800 border-bento-sage ring-2 ring-bento-sage/20'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Sinopse</label>
            <textarea
              id="input-book-synopsis"
              value={synopsis}
              onChange={(e) => setSynopsis(e.target.value)}
              placeholder="Escreva algo sobre este livro maravilhoso..."
              rows={4}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-bento-primary/20 focus:border-bento-primary text-sm text-slate-800 transition-all placeholder:text-slate-400 font-medium resize-none leading-relaxed"
            />
          </div>

          {/* Footer buttons */}
          <div className="pt-4 border-t border-slate-100 flex gap-3">
            <button
              id="btn-cancel-modal"
              type="button"
              onClick={onClose}
              className="flex-1 py-3 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-sm font-semibold transition-colors"
            >
              Cancelar
            </button>
            <button
              id="btn-save-modal"
              type="submit"
              className="flex-1 py-3 bg-bento-primary hover:bg-bento-primary/95 text-white rounded-xl text-sm font-semibold transition-colors shadow-md hover:shadow-lg shadow-bento-primary/10 flex items-center justify-center gap-1.5"
            >
              Salvar na Estante
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
