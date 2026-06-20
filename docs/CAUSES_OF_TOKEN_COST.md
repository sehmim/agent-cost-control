Based on the research, here are the main ways agent costs skyrocket:

1. Token Loops / Retry Loops (Biggest Cost Driver)
Problem	Cost	Example
Loop: Same prompt repeated 500 times	$12K+	Agent stuck, re-sending same query for 10 minutes 
Retry loop: Tool fails, retries 50 times	$500+	Agent can't solve problem, retries same tool 50x 
Background retries: Silent token consumption	$200+	Agent keeps retrying, no visible failure 
Why it happens: Agent hits a problem it can't solve → keeps retrying → no error, just spend.

Example: "An agent in a retry loop calls the same tool 50 times before timing out. Each call consumes tokens. Your billing dashboard sees 50x normal consumption."

2. Context Stuffing / Prompt Bloat
Problem	Cost	Example
Full database dump passed to agent	$47/run	Agent receives 400K entries instead of 1 week 
Full conversation history re-sent every call	$200+/day	Input tokens: 1K → 4K → 16K → 64K 
Large documents, verbose tool responses	$100+/run	Bloated inputs inflate per-run costs 
Why it happens: Schema change → agent receives unfiltered data → hits context limits → retries → bloat.

Example: "A schema change causes the agent to receive the entire unfiltered feedback table (400K entries). Normal cost: $0.20. One run: $47. Seven days: $329."

3. Redundant Model Usage
Problem	Cost	Example
Same question answered 5 times	5× cost	Weak caching → duplicate calls 
Parallel agents running at once	10× cost	10 agents processing same task 
Chaining multiple models per task	Multiplies cost	One task calling model 5 times instead of 1 
Complex workflows repeat model calls	Hidden cost	Task calling model 10 times unnecessarily 
Why it happens: No caching, poor orchestration, workflow design.

Example: "One task calling the model 5 times instead of 1 = 5× cost."

4. Data Retrieval Overhead
Problem	Cost	Example
Large vector indexes	Heavy compute	Bad chunking → fetch too much data 
Too many database lookups	Pressure on DB	Agent querying database 100 times/run 
Old/irrelevant data causes repeated queries	Repeat spend	Agent searching same data multiple times 
RAG design: Poor document structure	10× cost	AI searches more = higher cost 
Why it happens: Bad RAG design, poor chunking, inefficient vector search.

5. API & Integration Costs
Problem	Cost	Example
External API calls (CRM, email, payments)	Hidden costs	Agent calling 5 APIs = 5× cost 
Retries increase operating cost	2× cost	API fails, retries → double spend 
Moving data between systems	Bandwidth cost	Data transfer between APIs = extra spend 
High-volume workflows hit usage limits	Overage fees	10K calls → $500 overage 
Why it happens: Every external API call costs money, retries add up.

6. Feedback Loops (The "Real" Problem)
Problem	Cost	Example
Agent retries + re-retrieves + re-prompts	10× spend	Feedback loop without visible change 
Agent can't make progress, keeps retrying	Silent burn	Retry loop is valid behavior, no error 
Cost-amplifying loops	Real-time spike	Minutes matter when agent in loop 
Why it happens: "Cost explosions usually come from feedback loops, not single calls."

7. Infrastructure & Scaling
Problem	Cost	Example
Scaling agents increases infrastructure	More servers = more money	10 users → 100 servers 
Long context history storage	Storage cost	100K context → $100/storage 
Security hardening needs extra setup	Engineering cost	Hardening = $5K/month 
BYOM (Bring Your Own Model) needs GPUs	GPU cost	Self-hosted model = $10K/month 
8. Governance & Compliance
Problem	Cost	Example
Audit records required	Monitoring cost	EU AI Act = $2K/month 
Drift tracking adds monitoring	Compute cost	Bias checks = $1K/month 
Tuning agent behavior	Engineering cost	Skilled engineers = $10K/month 
