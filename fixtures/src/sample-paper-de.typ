// German-language sample paper used by Passage tests (source-language detection,
// non-English reading flow). Written for Passage and released under CC BY 4.0.
// Build: python fixtures/generate.py

#let title = "Aufmerksamkeit in der neuronalen maschinellen Übersetzung: Eine kurze Einführung"

#set document(title: title, author: "Passage Sample Documents")
#set page(
  paper: "a4",
  margin: (x: 2cm, top: 2.4cm, bottom: 2.2cm),
  columns: 2,
  footer: context {
    set text(size: 8.5pt)
    h(1fr)
    counter(page).display("1")
    h(1fr)
  },
)
#set columns(gutter: 0.8cm)
#set text(font: "Libertinus Serif", size: 10pt, lang: "de", hyphenate: true)
#set par(justify: true, leading: 0.5em, spacing: 0.5em, first-line-indent: 1em)
#set heading(numbering: "1")
#show heading: set text(size: 10.5pt, weight: "bold")
#show heading: set block(above: 1.2em, below: 0.7em)
#set math.equation(numbering: "(1)")

#place(top + center, float: true, scope: "parent", clearance: 1.6em)[
  #text(size: 16pt, weight: "bold")[#title]
  #v(0.7em)
  #text(size: 11pt)[Passage Sample Documents]
  #v(1em)
  #block(width: 82%)[
    #set par(first-line-indent: 0em)
    #set text(size: 9.5pt)
    #align(center, text(weight: "bold")[Zusammenfassung])
    #v(0.2em)
    Neuronale maschinelle Übersetzung überträgt einen Satz mit einem einzigen trainierbaren Netz aus einer Sprache in eine andere. Frühe Encoder-Decoder-Systeme verdichteten den gesamten Quellsatz zu einem Vektor fester Länge, was die Übersetzung langer Sätze erschwerte. Aufmerksamkeitsmechanismen beseitigen diesen Engpass, indem der Decoder in jedem Schritt auf alle Positionen des Quellsatzes zugreifen kann.
  ]
]

= Einleitung

Beim Übersetzen muss für jedes Wort der Ausgabe entschieden werden, welche Teile des Quellsatzes relevant sind. Statistische Systeme trafen diese Entscheidung ausdrücklich über Wortzuordnungen. Neuronale Systeme lernen sie dagegen aus Daten, und die Komponente, die diese weiche Zuordnung vornimmt, wird als Aufmerksamkeit bezeichnet.

Die Encoder-Decoder-Architektur war der erste neuronale Ansatz, der ganze Sätze durchgängig übersetzte. Ein Encoder liest den Quellsatz, und ein Decoder erzeugt die Übersetzung Token für Token. In der ursprünglichen Form fasste der Encoder den gesamten Satz in einem einzigen Vektor zusammen. Bei kurzen Sätzen funktionierte das erstaunlich gut, bei längeren Sätzen sank die Qualität jedoch deutlich.

= Aufmerksamkeit

Aufmerksamkeit ersetzt den konstanten Kontext durch einen schrittabhängigen. Im Decodierschritt $i$ erhält jede Quellposition $j$ eine Bewertung $e_(i j)$, die mit einer Softmax-Funktion normiert wird:

$ alpha_(i j) = exp(e_(i j)) / (sum_(k=1)^n exp(e_(i k))), quad c_i = sum_(j=1)^n alpha_(i j) h_j. $

Die Gewichte $alpha_(i j)$ sind nicht negativ und summieren sich zu eins. Sie lassen sich daher als weiche Zuordnung zwischen der Zielposition $i$ und dem Quellsatz lesen. Solche Visualisierungen zeigen oft plausible Wortentsprechungen, sollten aber nicht als vollständige Erklärung des Modellverhaltens gelten.

Der Transformer berechnet alle Aufmerksamkeitsausgaben gleichzeitig mit skalierten Skalarprodukten. Der Faktor $1 slash sqrt(d_k)$ verhindert, dass die Softmax-Funktion bei großen Dimensionen sättigt und die Gradienten verschwinden.

= Fazit

Aufmerksamkeit hat die neuronale maschinelle Übersetzung grundlegend verändert: Statt einen Satz in einen einzigen Vektor zu pressen, ruft das Modell in jedem Schritt die relevanten Informationen aus dem Quellsatz ab. Wer solche Modelle implementiert, sollte besonders auf Skalierung, Maskierung und eine einheitliche Auswertung achten.
