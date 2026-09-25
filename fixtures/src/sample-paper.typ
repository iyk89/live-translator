// Sample research paper used by Passage ("Try a sample paper") and by tests.
// Written for Passage and released under CC BY 4.0 (see fixtures/README.md).
// Build: python fixtures/generate.py

#let title = "Attention in Neural Machine Translation: A Short Tutorial"

#set document(title: title, author: "Passage Sample Documents")
#set page(
  paper: "us-letter",
  margin: (x: 0.75in, top: 0.95in, bottom: 0.9in),
  columns: 2,
  header: context {
    if counter(page).get().first() > 1 {
      set text(size: 8pt, fill: luma(90))
      emph(title)
      h(1fr)
      [Passage sample document]
    }
  },
  footer: context {
    set text(size: 8.5pt)
    h(1fr)
    counter(page).display("1")
    h(1fr)
  },
  background: context {
    if counter(page).get().first() == 1 {
      place(left + horizon, dx: 0.28in, rotate(-90deg, reflow: true,
        text(size: 9pt, fill: luma(120))[Passage sample document · CC BY 4.0 · Not peer reviewed]))
    }
  },
)
#set columns(gutter: 0.3in)
#set text(font: "Libertinus Serif", size: 10pt, lang: "en", hyphenate: true)
#set par(justify: true, leading: 0.5em, spacing: 0.5em, first-line-indent: 1em)
#set heading(numbering: "1.1")
#show heading: set text(size: 10.5pt, weight: "bold")
#show heading: set block(above: 1.2em, below: 0.7em)
#set math.equation(numbering: "(1)")
#set footnote.entry(separator: line(length: 30%, stroke: 0.5pt))
#show figure.caption: set text(size: 9pt)

#place(top + center, float: true, scope: "parent", clearance: 1.6em)[
  #text(size: 17pt, weight: "bold")[#title]
  #v(0.7em)
  #text(size: 11pt)[Passage Sample Documents#footnote[This tutorial was written as a sample document for the Passage reader. It summarizes published work and reports no new experimental results. Released under the Creative Commons Attribution 4.0 license.]]
  #v(1.1em)
  #block(width: 82%)[
    #set par(first-line-indent: 0em)
    #set text(size: 9.5pt)
    #align(center, text(weight: "bold")[Abstract])
    #v(0.2em)
    Neural machine translation maps a sentence in one language to a sentence in another with a single trainable network. Early encoder–decoder systems compressed the whole source sentence into one fixed-length vector, which made long sentences difficult to translate. Attention mechanisms removed this bottleneck by letting the decoder consult every source position at every step. This tutorial reviews how attention is computed, why the Transformer relies on it exclusively, and how translation quality is usually measured. We keep the notation consistent across sections and point out practical details that are easy to overlook, such as scaling, masking, and subword segmentation.
  ]
]

= Introduction

Translating a sentence requires deciding which parts of the source are relevant to each word of the output. Statistical systems made this decision explicit through word alignments. Neural systems instead learn it from data, and the component that performs this soft alignment is called attention.

The encoder–decoder architecture [7, 2] was the first neural design to translate whole sentences end to end. An encoder reads the source sentence and a decoder generates the translation one token at a time. In its original form the encoder summarized the entire sentence in a single vector. This worked surprisingly well for short sentences, but quality dropped as sentences grew longer, because a fixed-length vector cannot hold an arbitrary amount of information.

Attention [1] addressed this limitation. Instead of one summary vector, the decoder receives a different weighted combination of encoder states at every step. The weights are computed from the current decoder state, so the model can focus on different source words as the translation proceeds. Later work showed that attention alone, without any recurrence, is sufficient for state-of-the-art translation [8].

The rest of this tutorial is organized as follows. Section 2 introduces the encoder–decoder model. Section 3 defines attention and its common scoring functions. Section 4 describes self-attention and the Transformer. Section 5 covers evaluation, and Section 6 lists practical considerations.

= Encoder–Decoder Models

Let $x = (x_1, dots, x_n)$ be a source sentence and $y = (y_1, dots, y_m)$ its translation. A neural translation model defines the conditional probability of the output as a product of per-token terms:

$ p(y | x) = product_(i=1)^m p(y_i | y_(<i), x). $ <eq-factor>

The encoder turns $x$ into a sequence of hidden states $h_1, dots, h_n$. In recurrent models each state depends on the previous one, which makes the computation inherently sequential. Sutskever et al. [7] used deep LSTM networks and found that reversing the order of the source words made optimization noticeably easier, because it shortened the distance between the first source words and the first target words.

The decoder maintains its own state $s_i$ and predicts $y_i$ from $s_i$ and a context vector $c_i$. Without attention, $c_i$ is the same for every $i$: typically the final encoder state $h_n$. Every piece of information about the source must therefore flow through this one vector, no matter how long the sentence is.

= Attention

Attention replaces the constant context with a step-specific one. At decoding step $i$ the model assigns a score $e_(i j)$ to every source position $j$, normalizes the scores with a softmax, and forms the context as a weighted average:

$ alpha_(i j) = exp(e_(i j)) / (sum_(k=1)^n exp(e_(i k))), quad c_i = sum_(j=1)^n alpha_(i j) h_j. $ <eq-context>

The weights $alpha_(i j)$ are non-negative and sum to one, so they can be read as a soft alignment between target position $i$ and the source. Visualizing them often reveals plausible word correspondences, although attention weights should not be taken as a complete explanation of the model's behavior.

== Additive and Multiplicative Scoring

Bahdanau et al. [1] computed the score with a small feed-forward network, an approach usually called additive attention:

$ e_(i j) = v^top tanh(W s_(i-1) + U h_j). $ <eq-additive>

Luong et al. [5] compared several simpler alternatives, including the dot product $s_i^top h_j$ and a bilinear form $s_i^top W h_j$. Multiplicative scores are cheaper because they reduce to matrix products, which are highly optimized on modern hardware. They also distinguished global attention, which considers every source position, from local attention, which considers only a window around a predicted position.

== Scaled Dot-Product Attention

The Transformer [8] packs the queries, keys, and values into matrices $Q$, $K$, and $V$ and computes all attention outputs at once:

$ "Attention"(Q, K, V) = "softmax"((Q K^top) / sqrt(d_k)) V, $ <eq-sdpa>

where $d_k$ is the dimension of the keys. The factor $1 slash sqrt(d_k)$ matters in practice. If the components of queries and keys are independent with zero mean and unit variance, their dot product has variance $d_k$. For large $d_k$ the softmax then saturates, and its gradients become extremely small. Scaling keeps the scores in a range where learning remains efficient.

Multi-head attention runs several attention functions in parallel on different learned projections of the same inputs and concatenates the results. Each head can specialize, for example in local syntax or in long-distance agreement, while the total computation stays similar to that of a single head with full dimensionality.

= Self-Attention and the Transformer

In self-attention the queries, keys, and values all come from the same sequence, so every position can attend directly to every other position. This has two consequences. First, the number of sequential operations per layer is constant rather than proportional to the sentence length, which makes training much easier to parallelize. Second, the path between any two positions has length one, which helps the network learn long-range dependencies. The cost is quadratic in the sequence length, as summarized in Table 1.

#figure(
  table(
    columns: 4,
    stroke: none,
    align: (left, center, center, center),
    table.hline(stroke: 0.6pt),
    [*Layer type*], [*Per layer*], [*Sequential*], [*Path*],
    table.hline(stroke: 0.4pt),
    [Self-attention], [$O(n^2 d)$], [$O(1)$], [$O(1)$],
    [Recurrent], [$O(n d^2)$], [$O(n)$], [$O(n)$],
    [Convolutional], [$O(k n d^2)$], [$O(1)$], [$O(log_k n)$],
    table.hline(stroke: 0.6pt),
  ),
  caption: [Complexity per layer, minimum number of sequential operations, and maximum path length for sequence length $n$, representation dimension $d$, and kernel width $k$, following [8].],
) <tab-complexity>

Because attention itself ignores word order, the Transformer adds positional encodings to the input embeddings. The original model used fixed sinusoids of different frequencies, which allow the network to attend by relative position. Each layer combines attention with a position-wise feed-forward network, and every sublayer is wrapped in a residual connection [4] followed by layer normalization [3].

The decoder uses the same building blocks with two changes. Its self-attention is masked so that position $i$ cannot see positions after $i$, which preserves the factorization in Eq. (1). It also contains a cross-attention sublayer whose queries come from the decoder and whose keys and values come from the encoder output. The base configuration has six encoder and six decoder layers, a model dimension of 512, and eight attention heads. A larger variant reached 28.4 BLEU on the WMT 2014 English-to-German task, which was a new state of the art at the time of publication.

#figure(
  box(width: 100%, inset: (y: 4pt))[
    #set text(size: 8.5pt)
    #grid(
      columns: (1fr, 0.7fr, 1fr),
      align: center + horizon,
      rect(width: 100%, inset: 6pt, radius: 3pt, stroke: 0.6pt)[Encoder\ self-attention\ + feed-forward],
      [#sym.arrow.r #h(2pt) keys, values],
      rect(width: 100%, inset: 6pt, radius: 3pt, stroke: 0.6pt)[Decoder\ masked self-attention\ + cross-attention],
    )
  ],
  caption: [Information flow in an encoder–decoder Transformer. Cross-attention is the only path from the source to the target.],
) <fig-flow>

= Evaluating Translations

Human judgment remains the most reliable measure of translation quality, but it is slow and expensive. Automatic metrics compare system output with one or more reference translations. The most widely reported metric is BLEU [6], which combines modified $n$-gram precisions $p_n$ for $n = 1, dots, 4$ with a brevity penalty:

$ "BLEU" = "BP" dot exp(sum_(n=1)^4 w_n log p_n), $ <eq-bleu>

where the weights are usually uniform, $w_n = 1 slash 4$. The brevity penalty equals 1 when the candidate length $c$ exceeds the reference length $r$ and $exp(1 - r slash c)$ otherwise. BLEU scores depend on tokenization and on the number of references, so scores from different papers are comparable only when they were computed with the same settings.

= Practical Considerations

*Subword units.* Translation vocabularies are open: names, numbers, and compounds constantly produce unseen words. Byte-pair encoding [9] splits rare words into frequent subword units, and SentencePiece [10] applies a similar idea directly to raw text without language-specific pre-tokenization.

*Decoding.* Greedy decoding picks the most probable token at each step, while beam search keeps several partial hypotheses. Because longer hypotheses accumulate more negative log-probability, scores are often normalized by length [11]. A larger beam does not always help; very wide beams can favor short or empty outputs.

*Regularization.* The Transformer was trained with label smoothing of 0.1, which hurts perplexity because the model learns to be less certain, but improves accuracy and BLEU. Dropout is applied to the output of each sublayer and to the sums of embeddings and positional encodings.

*Masking.* Padding tokens must be excluded from attention. In practice this means adding a large negative number to the scores of padded positions before the softmax in Eq. (4), so that their weights become effectively zero. Forgetting this mask is one of the most common sources of subtle bugs.

= Conclusion

Attention changed neural machine translation from a model that compresses a sentence into one vector into a model that retrieves the relevant source information at every step. The same mechanism, applied within a sequence, became the foundation of the Transformer. Readers who implement these models should pay particular attention to scaling, masking, and consistent evaluation, since small differences in these details can change results considerably.

#v(0.6em)
#heading(numbering: none)[References]
#set text(size: 8.5pt)
#set par(first-line-indent: 0em, hanging-indent: 1.2em, spacing: 0.45em)

[1] D. Bahdanau, K. Cho, and Y. Bengio. Neural machine translation by jointly learning to align and translate. In _ICLR_, 2015.

[2] K. Cho, B. van Merriënboer, C. Gulcehre, D. Bahdanau, F. Bougares, H. Schwenk, and Y. Bengio. Learning phrase representations using RNN encoder–decoder for statistical machine translation. In _EMNLP_, 2014.

[3] J. L. Ba, J. R. Kiros, and G. E. Hinton. Layer normalization. _arXiv:1607.06450_, 2016.

[4] K. He, X. Zhang, S. Ren, and J. Sun. Deep residual learning for image recognition. In _CVPR_, 2016.

[5] M.-T. Luong, H. Pham, and C. D. Manning. Effective approaches to attention-based neural machine translation. In _EMNLP_, 2015.

[6] K. Papineni, S. Roukos, T. Ward, and W.-J. Zhu. BLEU: A method for automatic evaluation of machine translation. In _ACL_, 2002.

[7] I. Sutskever, O. Vinyals, and Q. V. Le. Sequence to sequence learning with neural networks. In _NeurIPS_, 2014.

[8] A. Vaswani, N. Shazeer, N. Parmar, J. Uszkoreit, L. Jones, A. N. Gomez, Ł. Kaiser, and I. Polosukhin. Attention is all you need. In _NeurIPS_, 2017.

[9] R. Sennrich, B. Haddow, and A. Birch. Neural machine translation of rare words with subword units. In _ACL_, 2016.

[10] T. Kudo and J. Richardson. SentencePiece: A simple and language independent subword tokenizer and detokenizer for neural text processing. In _EMNLP: System Demonstrations_, 2018.

[11] Y. Wu, M. Schuster, Z. Chen, Q. V. Le, M. Norouzi, et al. Google's neural machine translation system: Bridging the gap between human and machine translation. _arXiv:1609.08144_, 2016.
