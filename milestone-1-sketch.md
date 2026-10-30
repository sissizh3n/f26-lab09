# Milestone 1: CampusReserve as built

Drawn from the code, not from `ARCHITECTURE.md`. Every arrow names the class
that makes it true. Each picture comes twice, once in Mermaid and once in plain
text in the style of `ARCHITECTURE.md`.

## 1. Modules, what each writes, and who depends on whom

An arrow runs from a module to a module it imports. The label is the import
that proves the edge.

```mermaid
flowchart BT
  core["<b>core-domain</b><br/>writes nothing itself<br/>declares ports: RoomStore, UserStore,<br/>BookingStore, WaitlistStore, EventPublisher"]
  sto["<b>storage</b><br/>writes: room, user, booking, waitlist maps<br/>+ event log (list in memory, or JSONL file)"]
  notif["<b>notifications</b><br/>writes: InMemoryOutbox"]
  acc["<b>accounts</b><br/>writes: AccountDirectory maps,<br/>TokenService token map (in process)"]
  bill["<b>billing</b><br/>writes: InMemoryInvoiceStore"]
  http["<b>http-api</b><br/>writes nothing of its own<br/>wires one platform per process"]
  cli["<b>cli</b><br/>writes: events.jsonl (export-events)"]
  ana["<b>analytics</b> (Python)<br/>writes: reports to stdout"]
  file[("events.jsonl")]

  sto -->|"InMemoryBookingStore implements BookingStore"| core
  notif -->|"NotificationService implements EventPublisher"| core
  acc -->|"AccountDirectory.syncInto(UserStore)"| core
  bill -->|"InvoiceService reads BookingStore, RoomStore"| core
  bill -->|"InMemoryInvoiceStore extends InMemoryRecordStore"| sto
  http -->|"BookingService, AvailabilityService, RoomCatalog"| core
  http -->|"StoreRegistry; JsonLine.escape in JsonObject"| sto
  http -->|"NotificationService, InMemoryOutbox"| notif
  http -->|"TokenService, AuthorizationService, AccountDirectory"| acc
  cli -->|"BookingService, AvailabilityService"| core
  cli -->|"StoreRegistry, InMemoryEventLog (CliContext)"| sto
  cli -->|"InvoiceService"| bill

  cli -.->|"export-events writes"| file
  ana -.->|"reads only; no Java import"| file
```

Each block names a module and then every module that depends on it, with the
class that proves the edge.

```
core-domain    writes nothing itself, only through its ports
 ^  ^  ^  ^  ^  ^
 |  |  |  |  |  +--- cli            (BookingService, AvailabilityService)
 |  |  |  |  +------ http-api       (BookingService, AvailabilityService, RoomCatalog)
 |  |  |  +--------- billing        (InvoiceService reads BookingStore, RoomStore)
 |  |  +------------ accounts       (AccountDirectory.syncInto(UserStore))
 |  +--------------- notifications  (NotificationService implements EventPublisher)
 +------------------ storage        (InMemoryBookingStore implements BookingStore)

storage        writes: room, user, booking, waitlist maps; the event log
 ^  ^  ^
 |  |  +--- cli        (StoreRegistry, InMemoryEventLog in CliContext)
 |  +------ http-api   (StoreRegistry; JsonLine.escape in JsonObject)
 +--------- billing    (InMemoryInvoiceStore extends InMemoryRecordStore)

notifications  writes: InMemoryOutbox
 ^
 +--- http-api   (NotificationService, InMemoryOutbox)

accounts       writes: AccountDirectory maps, TokenService token map
 ^
 +--- http-api   (TokenService, AuthorizationService, AccountDirectory)

billing        writes: InMemoryInvoiceStore
 ^
 +--- cli        (InvoiceService)

http-api       writes nothing of its own; wires one platform per process
cli            writes: events.jsonl (export-events)

cli --export-events--> events.jsonl <--reads only-- analytics (Python, no Java import)
```

## 2. The availability request path

No token, and nothing is written.

- `-->` a call, numbered in order (A1–A4).
- `-.->` a port in `core-domain` and the `storage` class behind it at runtime.

```mermaid
flowchart TD
  reqA(["HTTP GET /rooms/{roomId}/availability?date=D<br/>no token"])
  cliA(["cli availability --room ID --date D"])

  subgraph HTTP["http-api"]
    Router["Router<br/>(HttpApiServer, default executor: one thread)"]
    RH["RoomsHandler.availability"]
  end

  subgraph CLI["cli"]
    AvCmd["CatalogCommands.Availability"]
  end

  subgraph CORE["core-domain"]
    Cat["RoomCatalog.find"]
    Avail["AvailabilityService<br/>freeOnDate, bookedMinutesOnDate, openSlotsOnDate"]
    PRoom{{"port RoomStore"}}
    PBook{{"port BookingStore"}}
  end

  subgraph STO["storage (StoreRegistry.inMemory, one set per process)"]
    IRoom[("InMemoryRoomStore")]
    IBook[("InMemoryBookingStore.findConflicts<br/>compares starts and ends itself")]
  end

  reqA --> Router
  Router -->|A1| RH
  cliA -->|A1| AvCmd
  RH -->|"A2 room exists?"| Cat
  AvCmd -->|"A2 room exists?"| Cat
  Cat --> PRoom
  RH -->|A3| Avail
  AvCmd -->|A3| Avail
  Avail -->|"A4 findConflicts(room, window)<br/>never reaches ConflictChecker"| PBook

  PRoom -.-> IRoom
  PBook -.-> IBook
```

```
HTTP GET /rooms/{roomId}/availability          CLI availability --room ID --date D
     |   (no token)                                       |
     v                                                    v
Router (http-api)                              CatalogCommands.Availability (cli)
     |                                                    |
     v                                                    |
RoomsHandler.availability (http-api)                      |
     |                                                    |
     +---------------------------+------------------------+
                                 |
                                 +----------> RoomCatalog.find (core-domain)
                                 |                 |
                                 |                 v
                                 |            RoomStore -> InMemoryRoomStore
                                 |            (port)       (storage)
                                 v
                    AvailabilityService (core-domain)
                    freeOnDate, bookedMinutesOnDate, openSlotsOnDate
                                 |
                                 v
                    BookingStore.findConflicts (port, core-domain)
                                 |
                                 v
                    InMemoryBookingStore.findConflicts (storage)
                    (compares two starts and two ends itself; never
                     reaches ConflictChecker or TimeInterval.overlaps)
```

## 3. The booking request path

- `==>` a call, numbered in order (B1–B11).
- `-.->` a port in `core-domain` and the `storage` class behind it at runtime,
  or wiring done at startup.
- Cylinders are state that something writes.

```mermaid
flowchart TD
  reqB(["HTTP POST /bookings<br/>Authorization: Bearer token"])
  cliB(["cli book --room --user --start --minutes"])

  subgraph HTTP["http-api"]
    Router["Router<br/>(HttpApiServer, default executor: one thread)"]
    BH["BookingsHandler.create"]
    RA["RequestAuth.require"]
  end

  subgraph CLI["cli (no token: --user is taken as given; no notification subscriber)"]
    BookCmd["BookingCommands.Book"]
  end

  subgraph ACC["accounts"]
    AS["AuthorizationService.authenticateHeader"]
    TS[("TokenService<br/>tokens in a LinkedHashMap, this process only")]
    AD[("AccountDirectory<br/>accounts in a HashMap")]
  end

  subgraph CORE["core-domain"]
    BS["BookingService.requestBooking"]
    Rules["BookingRules.checkRequest"]
    CC["ConflictChecker.hasConflict"]
    TI["TimeInterval.overlaps"]
    Dec{"room free?"}
    PRoom{{"port RoomStore"}}
    PUser{{"port UserStore"}}
    PBook{{"port BookingStore"}}
    PWait{{"port WaitlistStore"}}
    PEv{{"port EventPublisher"}}
  end

  subgraph STO["storage (StoreRegistry.inMemory, one set per process)"]
    IRoom[("InMemoryRoomStore")]
    IUser[("InMemoryUserStore")]
    IBook[("InMemoryBookingStore")]
    IWait[("InMemoryWaitlistStore")]
    ELP["EventLogPublisher.publish"]
    Log[("InMemoryEventLog<br/>(the HTTP server never exports it)")]
  end

  subgraph NOTE["notifications"]
    NS["NotificationService.publish"]
    Out[("InMemoryOutbox")]
  end

  reqB ==> Router
  Router ==>|B1| BH
  BH ==>|B2| RA
  RA ==> AS
  AS ==>|"B3 token value"| TS
  AS ==>|"B3 account active?"| AD
  BH ==>|"B4 BookingRequest(caller's userId)"| BS
  cliB ==> BookCmd
  BookCmd ==>|B4| BS
  BS ==>|"B5 room, user exist?"| PRoom
  BS ==>|B5| PUser
  BS ==>|B6| Rules
  BS ==>|"B7 findActiveByUser, findActiveByRoom"| PBook
  BS ==>|"B8 own calendar, then the room"| CC
  CC ==> TI
  CC ==> Dec
  Dec ==>|"B9 no: save WaitlistEntry, no event"| PWait
  Dec ==>|"B9 yes: save Booking"| PBook
  Dec ==>|"B10 yes: BookingCreatedEvent, failures swallowed"| PEv
  ELP ==>|"B11 write the log first"| Log
  ELP ==>|"B11 then each subscriber<br/>(attached in CampusReservePlatform)"| NS
  NS ==> Out

  PRoom -.-> IRoom
  PUser -.-> IUser
  PBook -.-> IBook
  PWait -.-> IWait
  PEv -.-> ELP
  AD -.->|"startup: syncInto"| PUser
```

```
HTTP POST /bookings                            CLI book --room --user --start --minutes
     |   (Authorization: Bearer token)                    |   (no token; --user taken as given)
     v                                                    v
Router (http-api)                              BookingCommands.Book (cli)
     |                                                    |
     v                                                    |
BookingsHandler.create (http-api)                         |
     |                                                    |
     +----------> RequestAuth.require (http-api)          |
     |                 |                                  |
     |                 v                                  |
     |            AuthorizationService (accounts)         |
     |                 |                                  |
     |                 +---> TokenService      (token map, this process only)
     |                 +---> AccountDirectory  (is the account active?)
     |                                                    |
     +---------------+------------------------------------+
                     v
         BookingService.requestBooking (core-domain)
                     |
                     +----------> RoomStore.findById, UserStore.exists  (ports)
                     |              -> InMemoryRoomStore, InMemoryUserStore  (storage)
                     |
                     +----------> BookingRules.checkRequest   (duration, alignment,
                     |                                         opening hours, one UTC day)
                     |
                     +----------> BookingStore.findActiveByUser, findActiveByRoom
                     |              -> InMemoryBookingStore  (storage)
                     |
                     +----------> ConflictChecker ---> TimeInterval.overlaps
                     |            (own calendar first, then the room)
                     |
                     +-- room taken --> WaitlistStore.save -> InMemoryWaitlistStore
                     |                  (storage, writes; no event is published)
                     |
                     +-- room free
                            |
                            v
                     BookingStore.save -> InMemoryBookingStore  (storage, writes)
                            |
                            v
                     EventPublisher.publish(BookingCreatedEvent)
                     (core-domain port; BookingService swallows failures)
                            |
                            v
                     EventLogPublisher (storage)
                        |                       |
                        v  first                v  then
                  InMemoryEventLog         NotificationService (notifications)
                  (writes; the HTTP        (HTTP only: the CLI attaches none)
                   server never                 |
                   exports it)                  v
                                           InMemoryOutbox  (writes)
```
1. Availability skips ConflictChecker. RoomsHandler calls AvailabilityService, which calls BookingStore.findConflicts. AGENTS.md rule 3 says availability goes through the one overlap check.
2. A second overlap check exists. InMemoryBookingStore.findConflicts compares the two starts and two ends inline. 
3. Availability isn't in the booking diagram. CampusReservePlatform gives AvailabilityService the booking store directly, without going through BookingService.
4. CLI book has no token check. 
