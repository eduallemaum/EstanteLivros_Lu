import { useState, useEffect } from 'react';
import { Book } from './types';
import { db } from './firebase';
import {
  collection,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  query,
  orderBy
} from 'firebase/firestore';
import { BookCard } from './components/BookCard';
import { BookModal } from './components/BookModal';
import { ScannerModal } from './components/ScannerModal';
import {
  Search,
  Plus,
  Camera,
  Sparkles,
  Library,
  BookOpen,
  CheckCircle,
  Clock,
  ChevronRight,
  TrendingUp,
  Award,
  ChevronUp,
  ChevronDown,
  Percent,
  Compass,
  LayoutDashboard,
  Layers
} from 'lucide-react';

const DEFAULT_BOOKS: Book[] = [
  {
    id: 'default_1',
    title: 'O Nome da Rosa',
    author: 'Umberto Eco',
    genre: 'Mistério/Ficção Histórica',
    pages: 560,
    synopsis: 'Na Itália medieval, em um mosteiro franciscano isolado, monges começam a morrer de forma misteriosa e assustadora. O frade Guilherme de Baskerville e seu noviço Adso de Melk tentam decifrar os segredos de uma biblioteca labiríntica e cheia de segredos.',
    status: 'Lido',
    coverImage: 'https://images-na.ssl-images-amazon.com/images/I/51rR-Zq-F1L._SX331_BO1,204,203,200_.jpg'
  },
  {
    id: 'default_2',
    title: 'Cem Anos de Solidão',
    author: 'Gabriel García Márquez',
    genre: 'Realismo Mágico',
    pages: 448,
    synopsis: 'A saga multigeracional da família Buendía na fictícia cidade de Macondo. Uma obra-prima literária que combina o fantástico e o cotidiano para narrar a solidão, o amor, a guerra e o destino humano.',
    status: 'Lido',
    coverImage: 'https://images-na.ssl-images-amazon.com/images/I/817FFN3upTL.jpg'
  },
  {
    id: 'default_3',
    title: 'A Garota do Lago',
    author: 'Charlie Donlea',
    genre: 'Suspense',
    pages: 296,
    synopsis: 'Uma jovem jornalista investigativa tenta desvendar o violento assassinato de uma estudante de medicina em uma pacata cidade de veraneio cercada por mistérios e segredos de família.',
    status: 'Lendo',
    coverImage: 'https://images-na.ssl-images-amazon.com/images/I/51Iu9m2847L._SX337_BO1,204,203,200_.jpg'
  },
  {
    id: 'default_4',
    title: 'Admirável Mundo Novo',
    author: 'Aldous Huxley',
    genre: 'Ficção Científica',
    pages: 312,
    synopsis: 'Uma visão assustadora e profética de uma sociedade futura altamente controlada, condicionada geneticamente e anestesiada pelo prazer e pelo consumo, onde a individualidade é proibida.',
    status: 'Quero Ler',
    coverImage: 'https://images-na.ssl-images-amazon.com/images/I/41-TshG-Y5L._SX322_BO1,204,203,200_.jpg'
  },
  {
    id: 'default_5',
    title: 'Mulheres que Correm com os Lobos',
    author: 'Clarissa Pinkola Estés',
    genre: 'Psicologia/Mitologia',
    pages: 576,
    synopsis: 'Uma profunda análise dos arquétipos femininos através de mitos, contos de fadas e histórias ancestrais, resgatando a essência da "Mulher Selvagem" e sua força vital oculta.',
    status: 'Quero Ler',
    coverImage: 'https://images-na.ssl-images-amazon.com/images/I/51lO06NfLML._SX323_BO1,204,203,200_.jpg'
  },
  {
    id: 'default_6',
    title: 'Um Estudo em Vermelho',
    author: 'Arthur Conan Doyle',
    genre: 'Mistério/Policial',
    pages: 168,
    synopsis: 'A primeira história de Sherlock Holmes e Dr. Watson. O mistério começa com um cadáver encontrado em uma casa abandonada com a palavra "Rache" escrita em sangue na parede.',
    status: 'Lido',
    coverImage: 'https://images-na.ssl-images-amazon.com/images/I/51U631N6GQL.jpg',
    inBoxSet: true,
    boxSetName: 'Box Sherlock Holmes',
    boxSetVolume: 'Vol. 1',
    publisher: 'HarperCollins',
    publishYear: '2019'
  },
  {
    id: 'default_7',
    title: 'E Não Sobrou Nenhum',
    author: 'Agatha Christie',
    genre: 'Mistério/Policial',
    pages: 400,
    synopsis: 'Dez pessoas sem ligação aparente são convidadas para uma ilha misteriosa. Uma a uma, elas começam a morrer conforme uma antiga canção infantil.',
    status: 'Quero Ler',
    coverImage: 'https://images-na.ssl-images-amazon.com/images/I/81e5F9V6M8L.jpg',
    inBoxSet: true,
    boxSetName: 'Coleção Agatha Christie - Box 1',
    boxSetVolume: 'Volume 1',
    publisher: 'HarperCollins',
    publishYear: '2020'
  }
];

export async function fetchBookCover(title: string, author: string): Promise<string | undefined> {
  try {
    const query = encodeURIComponent(`intitle:${title}${author ? ` inauthor:${author}` : ''}`);
    const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1`);
    if (!response.ok) return undefined;
    const data = await response.json();
    if (data.items && data.items.length > 0) {
      const volumeInfo = data.items[0].volumeInfo;
      if (volumeInfo.imageLinks && volumeInfo.imageLinks.thumbnail) {
        return volumeInfo.imageLinks.thumbnail.replace(/^http:/, 'https:');
      }
    }
  } catch (error) {
    console.error('Failed to fetch cover from Google Books:', error);
  }
  return undefined;
}

export default function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('Todos');
  const [onlyBoxSets, setOnlyBoxSets] = useState<boolean>(false);

  // Modal states
  const [isBookModalOpen, setIsBookModalOpen] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [editingBook, setEditingBook] = useState<Book | null>(null);

  // AI Scanned books review queue
  const [reviewQueue, setReviewQueue] = useState<Book[]>([]);
  const [isReviewMode, setIsReviewMode] = useState(false);

  // Dynamic Reading Goal State
  const [readingGoal, setReadingGoal] = useState<number>(() => {
    const saved = localStorage.getItem('estante_da_lu_goal');
    return saved ? parseInt(saved, 10) : 24;
  });

  const updateReadingGoal = (newGoal: number) => {
    if (newGoal < 1) return;
    setReadingGoal(newGoal);
    localStorage.setItem('estante_da_lu_goal', newGoal.toString());
  };

  // Firestore & LocalStorage Sync
  useEffect(() => {
    let unsubscribe = () => {};
    try {
      const q = query(collection(db, 'books'), orderBy('createdAt', 'desc'));
      unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const booksData: Book[] = [];
          snapshot.forEach((docSnap) => {
            booksData.push({ id: docSnap.id, ...docSnap.data() } as Book);
          });
          
          if (booksData.length === 0) {
            // Seed defaults when Firestore has no records
            setBooks(DEFAULT_BOOKS);
            localStorage.setItem('estante_da_lu_backup', JSON.stringify(DEFAULT_BOOKS));
          } else {
            setBooks(booksData);
            localStorage.setItem('estante_da_lu_backup', JSON.stringify(booksData));
          }
          setLoading(false);
        },
        (error) => {
          console.warn('Firestore subscription failed, falling back to local storage:', error);
          loadFromBackup();
        }
      );
    } catch (err) {
      console.warn('Error starting Firestore, using local storage backup:', err);
      loadFromBackup();
    }

    return () => unsubscribe();
  }, []);

  const loadFromBackup = () => {
    const backup = localStorage.getItem('estante_da_lu_backup');
    if (backup) {
      const parsed = JSON.parse(backup);
      if (parsed.length === 0) {
        setBooks(DEFAULT_BOOKS);
      } else {
        setBooks(parsed);
      }
    } else {
      setBooks(DEFAULT_BOOKS);
    }
    setLoading(false);
  };

  // Add or update book in Firestore
  const handleSaveBook = async (bookData: Omit<Book, 'id'> & { id?: string }) => {
    try {
      const { id, ...cleanData } = bookData;

      // Auto-fetch cover if not provided
      if (!cleanData.coverImage) {
        const cover = await fetchBookCover(cleanData.title, cleanData.author);
        if (cover) {
          cleanData.coverImage = cover;
        }
      }

      if (id) {
        // Update
        const bookRef = doc(db, 'books', id);
        await updateDoc(bookRef, {
          ...cleanData,
          updatedAt: serverTimestamp(),
        });
      } else {
        // Create
        await addDoc(collection(db, 'books'), {
          ...cleanData,
          createdAt: serverTimestamp(),
        });
      }
    } catch (err) {
      console.error('Error saving book to Firestore, saving to local state:', err);
      // Fallback local modification
      let updatedList = [...books];
      if (bookData.id) {
        updatedList = updatedList.map((b) => (b.id === bookData.id ? { ...b, ...bookData } : b));
      } else {
        const newLocalBook = { ...bookData, id: `local_${Date.now()}` } as Book;
        updatedList = [newLocalBook, ...updatedList];
      }
      setBooks(updatedList);
      localStorage.setItem('estante_da_lu_backup', JSON.stringify(updatedList));
    }

    // If we are in AI review mode, advance to next book in queue
    if (isReviewMode) {
      const nextQueue = [...reviewQueue];
      nextQueue.shift(); // Remove current reviewed book
      setReviewQueue(nextQueue);

      if (nextQueue.length > 0) {
        setEditingBook(nextQueue[0]);
      } else {
        setIsReviewMode(false);
        setEditingBook(null);
      }
    }
  };

  const handleDeleteBook = async (id: string) => {
    if (!confirm('Deseja mesmo remover este livro da sua estante?')) return;

    try {
      await deleteDoc(doc(db, 'books', id));
    } catch (err) {
      console.error('Error deleting from Firestore, updating locally:', err);
      const updatedList = books.filter((b) => b.id !== id);
      setBooks(updatedList);
      localStorage.setItem('estante_da_lu_backup', JSON.stringify(updatedList));
    }
  };

  // Handle books scanned from camera
  const handleBooksScanned = async (scannedBooks: Book[]) => {
    if (scannedBooks.length > 0) {
      // Pre-fetch covers for all books in the review queue to display them immediately
      const booksWithCovers = await Promise.all(
        scannedBooks.map(async (book) => {
          if (!book.coverImage) {
            const coverImage = await fetchBookCover(book.title, book.author);
            return { ...book, coverImage };
          }
          return book;
        })
      );
      setReviewQueue(booksWithCovers);
      setIsReviewMode(true);
      setEditingBook(booksWithCovers[0]);
      setIsBookModalOpen(true);
    }
  };

  const handleCloseBookModal = () => {
    setIsBookModalOpen(false);
    setEditingBook(null);
    if (isReviewMode) {
      // If they cancel review mode, discard remainder of queue
      setIsReviewMode(false);
      setReviewQueue([]);
    }
  };

  // Stats calculation
  const totalBooks = books.length;
  const readingBooks = books.filter((b) => b.status === 'Lendo').length;
  const readBooks = books.filter((b) => b.status === 'Lido').length;
  const wantToReadBooks = books.filter((b) => b.status === 'Quero Ler').length;

  // Filter & search books list
  const filteredBooks = books.filter((book) => {
    const matchesSearch =
      book.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      book.author.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (book.genre && book.genre.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (book.synopsis && book.synopsis.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus = selectedStatus === 'Todos' || book.status === selectedStatus;
    const matchesBoxSet = !onlyBoxSets || book.inBoxSet;

    return matchesSearch && matchesStatus && matchesBoxSet;
  });

  // Calculate percentage of target goal
  const readingGoalPercentage = Math.min(100, Math.round((readBooks / readingGoal) * 100)) || 0;

  return (
    <div className="min-h-screen bg-bento-bg text-bento-text font-sans selection:bg-bento-primary/20 flex flex-col md:flex-row p-4 md:p-8 gap-6">
      
      {/* Sidebar Navigation - Visible on Medium & Up, Collapsed on Mobile */}
      <aside className="w-full md:w-64 shrink-0 flex flex-col gap-6 md:py-2">
        {/* Sidebar Brand Header */}
        <div className="flex items-center justify-between md:block px-2">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-bento-primary to-bento-purple flex items-center justify-center text-white shadow-lg shadow-bento-primary/25">
                <Library className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-xl font-extrabold tracking-tight text-bento-primary leading-tight flex items-center gap-1.5">
                  Estante da Lu <span className="text-sm">🐱</span>
                </h1>
                <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">
                  Biblioteca Pessoal
                </p>
              </div>
            </div>
          </div>
          
          {/* Quick add button for mobile top-bar */}
          <button
            id="btn-add-top-mobile"
            onClick={() => {
              setEditingBook(null);
              setIsBookModalOpen(true);
            }}
            className="md:hidden flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bento-primary text-white text-xs font-bold shadow-md shadow-bento-primary/20"
          >
            <Plus className="w-4 h-4" /> Adicionar
          </button>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex md:flex-col gap-2 bg-white/60 md:bg-transparent p-1.5 md:p-0 rounded-2xl border border-slate-200/50 md:border-none">
          <button
            id="nav-btn-dashboard"
            onClick={() => {
              setSearchQuery('');
              setSelectedStatus('Todos');
            }}
            className={`flex-1 md:flex-none flex items-center justify-center md:justify-start gap-3 px-4 py-3 rounded-xl md:rounded-2xl text-sm font-bold transition-all ${
              selectedStatus === 'Todos' && !searchQuery
                ? 'bg-white text-bento-primary shadow-sm border border-slate-100'
                : 'text-slate-500 hover:bg-white/50 hover:text-slate-700'
            }`}
          >
            <LayoutDashboard className="w-4 h-4" />
            <span className="hidden sm:inline md:inline">Painel</span>
          </button>
          <button
            id="nav-btn-reading"
            onClick={() => {
              setSearchQuery('');
              setSelectedStatus('Lendo');
            }}
            className={`flex-1 md:flex-none flex items-center justify-center md:justify-start gap-3 px-4 py-3 rounded-xl md:rounded-2xl text-sm font-bold transition-all ${
              selectedStatus === 'Lendo'
                ? 'bg-white text-bento-primary shadow-sm border border-slate-100'
                : 'text-slate-500 hover:bg-white/50 hover:text-slate-700'
            }`}
          >
            <Clock className="w-4 h-4" />
            <span className="hidden sm:inline md:inline">Lendo</span>
          </button>
          <button
            id="nav-btn-read"
            onClick={() => {
              setSearchQuery('');
              setSelectedStatus('Lido');
            }}
            className={`flex-1 md:flex-none flex items-center justify-center md:justify-start gap-3 px-4 py-3 rounded-xl md:rounded-2xl text-sm font-bold transition-all ${
              selectedStatus === 'Lido'
                ? 'bg-white text-bento-primary shadow-sm border border-slate-100'
                : 'text-slate-500 hover:bg-white/50 hover:text-slate-700'
            }`}
          >
            <CheckCircle className="w-4 h-4" />
            <span className="hidden sm:inline md:inline">Lidos</span>
          </button>
        </nav>

        {/* Reading Goal Widget (Bento Style) */}
        <div className="bg-gradient-to-br from-bento-primary to-bento-purple p-6 rounded-3xl text-white shadow-lg shadow-bento-primary/10 relative overflow-hidden flex flex-col justify-between min-h-[160px] md:mt-auto">
          {/* Subtle design element */}
          <div className="absolute -right-6 -bottom-6 w-24 h-24 bg-white/10 rounded-full" />
          
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider opacity-90">Meta de Leitura</span>
              <Award className="w-4 h-4 text-bento-orange" />
            </div>
            
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-black">{readBooks}</span>
              <span className="text-sm opacity-70">de</span>
              <div className="inline-flex items-center gap-1 bg-white/10 px-2 py-0.5 rounded-lg">
                <span className="text-sm font-bold">{readingGoal}</span>
                <div className="flex flex-col text-[8px] leading-none">
                  <button
                    id="btn-increase-goal"
                    onClick={() => updateReadingGoal(readingGoal + 1)}
                    className="hover:text-bento-orange transition-colors"
                  >
                    <ChevronUp className="w-2.5 h-2.5" />
                  </button>
                  <button
                    id="btn-decrease-goal"
                    onClick={() => updateReadingGoal(readingGoal - 1)}
                    className="hover:text-bento-orange transition-colors"
                  >
                    <ChevronDown className="w-2.5 h-2.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4">
            <div className="flex justify-between items-center text-xs mb-1 opacity-85">
              <span>{readingGoalPercentage}% Concluído</span>
              <span>{readBooks}/{readingGoal} livros</span>
            </div>
            <div className="w-full bg-white/20 h-2 rounded-full overflow-hidden">
              <div
                className="bg-bento-orange h-full rounded-full transition-all duration-500"
                style={{ width: `${readingGoalPercentage}%` }}
              />
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col gap-6 min-w-0">
        
        {/* Header / Search Controls */}
        <header className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 justify-between">
          {/* Search bar inside header */}
          <div className="relative flex-1 max-w-xl">
            <span className="absolute inset-y-0 left-4 flex items-center text-slate-400 pointer-events-none">
              <Search className="w-5 h-5" />
            </span>
            <input
              id="search-input"
              type="text"
              placeholder="Pesquisar por título, autor ou gênero..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white border-none rounded-2xl py-3.5 pl-12 pr-4 shadow-sm focus:outline-none focus:ring-2 focus:ring-bento-primary/20 text-sm placeholder-slate-400 font-medium"
            />
          </div>

          {/* User profile identifier & quick action */}
          <div className="flex items-center gap-3 justify-end">
            <button
              id="btn-header-add"
              onClick={() => {
                setEditingBook(null);
                setIsBookModalOpen(true);
              }}
              className="bg-white p-3 rounded-2xl shadow-sm text-slate-500 hover:text-bento-primary hover:bg-slate-50 transition-all hidden sm:block"
              title="Adicionar livro manualmente"
            >
              <Plus className="w-5 h-5" />
            </button>
            <div className="w-12 h-12 rounded-2xl bg-bento-purple flex items-center justify-center text-white font-extrabold text-lg border-4 border-white shadow-sm" title="Jornalista Luciana 🐱">
              🐱
            </div>
          </div>
        </header>

        {/* Dynamic Bento Grid Layout */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 flex-1">
          
          {/* Large Main Card (Estante Box) */}
          <section className="md:col-span-8 md:row-span-4 bg-white rounded-[2rem] p-6 md:p-8 shadow-sm flex flex-col border border-slate-100">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
              <div>
                <h2 className="text-xl font-extrabold text-slate-800 tracking-tight">Minha Estante</h2>
                <p className="text-xs text-slate-400 font-medium">A curadoria literária da jornalista Lu</p>
              </div>

              {/* Filters & Toggles inside the Main Box */}
              <div className="flex flex-wrap items-center gap-2.5 self-stretch sm:self-auto">
                <div className="flex gap-1.5 bg-slate-100 p-1 rounded-xl overflow-x-auto no-scrollbar">
                  {['Todos', 'Quero Ler', 'Lendo', 'Lido'].map((status) => (
                    <button
                      key={status}
                      id={`filter-pill-${status.replace(' ', '-')}`}
                      onClick={() => setSelectedStatus(status)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                        selectedStatus === status
                          ? 'bg-white text-bento-primary shadow-sm'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {status}
                    </button>
                  ))}
                </div>

                <button
                  id="btn-filter-box-sets"
                  onClick={() => setOnlyBoxSets(!onlyBoxSets)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 border transition-all ${
                    onlyBoxSets
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-sm'
                      : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                  }`}
                  title="Exibir apenas livros que fazem parte de um Box ou Coleção"
                >
                  <Layers className={`w-3.5 h-3.5 ${onlyBoxSets ? 'text-indigo-600' : 'text-slate-400'}`} />
                  <span>Boxes</span>
                </button>
              </div>
            </div>

            {/* Shelf Items Area */}
            <div className="flex-1">
              {loading ? (
                /* Shimmer placeholders matching the grid */
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {[1, 2].map((i) => (
                    <div key={i} className="h-44 bg-slate-50 rounded-2xl border border-dashed border-slate-200 animate-pulse" />
                  ))}
                </div>
              ) : filteredBooks.length === 0 ? (
                /* Clean elegant empty state inside the Bento Box with custom journalism allusion */
                <div className="h-full flex flex-col items-center justify-center text-center p-8 py-16">
                  <div className="w-16 h-16 rounded-2xl bg-bento-lavender flex items-center justify-center text-bento-primary mb-4 relative">
                    <Library className="w-7 h-7" />
                    <span className="absolute -bottom-1 -right-1 bg-white text-xs p-1 rounded-full shadow-sm border border-slate-100">🖨️</span>
                  </div>
                  <h3 className="font-extrabold text-slate-800 text-base">Nenhum livro encontrado</h3>
                  <p className="text-xs text-slate-400 max-w-xs mt-1.5 leading-relaxed">
                    {searchQuery
                      ? 'Nenhum resultado corresponde à sua pesquisa. Tente usar outras palavras.'
                      : 'Nenhum livro cadastrado nesta seção. Que tal alimentar a máquina de escrever com novas histórias?'}
                  </p>
                  <div className="mt-4 text-[10px] text-slate-400 font-serif italic flex items-center gap-1.5">
                    <span>⚘ Lírios & novas pautas da Lu ⚘</span>
                  </div>
                </div>
              ) : (
                /* Scrollable visual grid of customized book cards */
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-h-[600px] overflow-y-auto pr-1 no-scrollbar">
                  {filteredBooks.map((book) => (
                    <BookCard
                      key={book.id}
                      book={book}
                      onEdit={(b) => {
                        setEditingBook(b);
                        setIsBookModalOpen(true);
                      }}
                      onDelete={handleDeleteBook}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Stats Side Card (Rhythm & Growth) */}
          <section className="md:col-span-4 md:row-span-2 bg-bento-primary rounded-[2rem] p-6 shadow-lg shadow-bento-primary/10 text-white flex flex-col justify-between relative overflow-hidden">
            {/* Visual background vector shape */}
            <div className="absolute -left-10 -bottom-10 w-36 h-36 bg-white/5 rounded-full pointer-events-none" />

            <div className="flex items-center gap-4 mb-4">
              <div className="p-3 bg-white/10 rounded-2xl">
                <TrendingUp className="w-5 h-5 text-bento-orange" />
              </div>
              <div>
                <h3 className="font-bold text-sm font-serif">Pauta Literária</h3>
                <p className="text-[10px] text-white/70">Histórias & Notas da Lu</p>
              </div>
            </div>

            <div className="my-2 flex flex-col gap-2">
              <p className="text-xs font-serif leading-relaxed text-bento-lavender italic">
                "Luciana, sua próxima grande história começa na próxima página."
              </p>
              {readBooks > 0 ? (
                <div className="mt-1">
                  <p className="text-4xl font-black tracking-tight text-white flex items-baseline gap-1">
                    +{Math.round((readBooks / (totalBooks || 1)) * 100)}%
                  </p>
                  <p className="text-xs opacity-80 mt-1 leading-relaxed">
                    Da sua curadoria especial de {totalBooks} livros foi finalizada! 
                  </p>
                </div>
              ) : (
                <div className="mt-1">
                  <p className="text-xl font-bold tracking-tight">Pronta para Começar!</p>
                  <p className="text-xs opacity-85 mt-1 leading-relaxed">
                    Registre os livros que já leu para exibir suas estatísticas completas de leitura aqui.
                  </p>
                </div>
              )}
            </div>

            <div className="text-[11px] opacity-70 mt-auto border-t border-white/10 pt-3 flex justify-between items-center">
              <span>Preferência por jornalismo & literatura</span>
              <span>🐱</span>
            </div>
          </section>

          {/* Status Distribution Breakdown Bento Box */}
          <section className="md:col-span-4 md:row-span-2 bg-white rounded-[2rem] p-6 border border-slate-100 shadow-sm flex flex-col justify-between">
            <div>
              <h3 className="font-extrabold text-slate-800 text-sm tracking-tight mb-4 uppercase opacity-80">Distribuição</h3>
              <div className="space-y-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-500 flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" /> Lido
                  </span>
                  <span className="text-xs font-bold text-slate-700 bg-emerald-500/10 px-2 py-0.5 rounded-md">{readBooks}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-500 flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-bento-primary" /> Lendo
                  </span>
                  <span className="text-xs font-bold text-slate-700 bg-bento-primary/10 px-2 py-0.5 rounded-md">{readingBooks}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-500 flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-bento-purple" /> Quero Ler
                  </span>
                  <span className="text-xs font-bold text-slate-700 bg-bento-purple/10 px-2 py-0.5 rounded-md">{wantToReadBooks}</span>
                </div>
              </div>
            </div>

            <div className="text-[10px] text-slate-400 font-medium pt-3 mt-4 border-t border-slate-50">
              Total de {totalBooks} registros no Firestore.
            </div>
          </section>

          {/* Large Floating Action Prompt (Bento-style Lavender Banner) */}
          <section className="md:col-span-12 md:row-span-2 bg-bento-lavender rounded-[2rem] p-6 shadow-sm flex flex-col sm:flex-row items-center justify-between relative overflow-hidden border border-violet-100/30 gap-6">
            <div className="z-10 text-center sm:text-left">
              <h2 className="text-xl md:text-2xl font-black text-bento-primary tracking-tight">Nova aquisição física?</h2>
              <p className="text-bento-primary/70 text-xs md:text-sm mt-1 max-w-md font-medium">
                Use a câmera inteligente integrada para identificar lombadas e catalogar livros na estante de forma totalmente automatizada.
              </p>
            </div>
            
            <button
              id="btn-scan-bento-prompt"
              onClick={() => setIsScannerOpen(true)}
              className="z-10 bg-bento-primary hover:bg-bento-primary/95 text-white px-6 md:px-8 py-3.5 rounded-xl font-bold text-xs shadow-lg shadow-bento-primary/20 flex items-center gap-2.5 active:scale-95 transition-all"
            >
              <Camera className="w-4 h-4" />
              Escanear Livro com IA
            </button>
            
            {/* Elegant background shapes to mimic the design */}
            <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-bento-primary/10 rounded-full" />
            <div className="absolute top-5 right-20 w-12 h-12 bg-white/40 rounded-full" />
          </section>

        </div>
      </main>

      {/* Intelligent AI Review Drawer (When Scanned item list is in queue) */}
      {isReviewMode && reviewQueue.length > 0 && (
        <div className="fixed bottom-6 left-4 right-4 md:left-auto md:right-8 md:w-80 z-40 bg-gradient-to-r from-bento-orange to-bento-red rounded-2xl p-4 shadow-xl text-white flex items-center justify-between animate-bounce">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-5 h-5 shrink-0" />
            <div>
              <p className="text-xs font-black uppercase tracking-wider">Modo Revisão IA</p>
              <p className="text-[10px] opacity-90 font-semibold">
                Analisando {reviewQueue.length} {reviewQueue.length === 1 ? 'livro' : 'livros'}
              </p>
            </div>
          </div>
          <button
            onClick={() => setIsBookModalOpen(true)}
            className="px-3 py-1.5 rounded-xl bg-white text-bento-red text-xs font-black shadow-md hover:bg-slate-50 transition-colors flex items-center gap-1"
          >
            Revisar <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Sticky Mobile Floating Button */}
      <button
        id="btn-floating-camera-sticky"
        onClick={() => setIsScannerOpen(true)}
        className="fixed bottom-6 right-6 md:hidden z-40 w-14 h-14 rounded-full bg-gradient-to-tr from-bento-primary to-bento-purple text-white shadow-xl shadow-bento-primary/30 flex items-center justify-center transition-all hover:scale-105 active:scale-95"
        title="Escanear com IA"
      >
        <Camera className="w-6 h-6" />
      </button>

      {/* Modals */}
      <BookModal
        isOpen={isBookModalOpen}
        onClose={handleCloseBookModal}
        onSave={handleSaveBook}
        bookToEdit={editingBook}
        isAiGenerated={isReviewMode}
        existingBooks={books}
      />

      <ScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onBooksScanned={handleBooksScanned}
      />
    </div>
  );
}
