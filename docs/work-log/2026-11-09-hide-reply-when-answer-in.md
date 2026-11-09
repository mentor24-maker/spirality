## 2026-11-09 — Remove feedback form field if Your answer is in. (#129)

When Dane answered a ticket (pressing Merge, Close or Go, or typing a reply), the ticket page said "Your answer is in" but still showed the reply box under it. That was misleading. Until the relay acts, his answer is the newest comment, so a second reply typed in that gap would land on top of the first and quietly overrule it.

Now the reply box and its Post Reply button go away while his answer is in. They come back once the relay comments, the same way the Merge, Close and Go buttons already did. The "Your answer is in" line on the ticket page is now a boxed notice with a light blue background and a blue bar down its left side, instead of small grey italic text, so it is the obvious thing on the page. Opening the ticket's "#reply" link while the answer is in just shows the notice, with nothing broken.
