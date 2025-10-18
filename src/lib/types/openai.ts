type Segment = {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
};

type Word = {
  word: string;
  start: number;
  end: number;
};

export type WhisperResponse = {
  task: string;
  language: string;
  duration: number;
  text: string;
};

export type WhisperResponseWithSegments = WhisperResponse & {
  segments: Segment[];
};

export type WhisperResponseWithWords = WhisperResponse & {
  words: Word[];
};

export type WhisperResponseWithSegmentsAndWords = WhisperResponse & {
  segments: Segment[];
  words: Word[];
};
