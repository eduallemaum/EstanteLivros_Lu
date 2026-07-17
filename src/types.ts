export interface Book {
  id?: string;
  title: string;
  author: string;
  genre: string;
  pages: number;
  synopsis: string;
  status: 'Quero Ler' | 'Lendo' | 'Lido';
  createdAt?: any;
  coverImage?: string; // Optional cover placeholder color or generated asset
  isbn?: string;
  publisher?: string;
  publishYear?: string;
  edition?: string;
  inBoxSet?: boolean;
  boxSetName?: string;
  boxSetVolume?: string;
}
