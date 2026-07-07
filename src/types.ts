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
}
