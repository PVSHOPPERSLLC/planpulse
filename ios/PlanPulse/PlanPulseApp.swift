import SwiftUI

@main
struct PlanPulseApp: App {
    var body: some Scene {
        WindowGroup { PlanPulseView() }
    }
}

private enum Focus: String, CaseIterable, Identifiable {
    case meal = "Meal", fitness = "Fitness", study = "Study"
    var id: String { rawValue }
}

private struct PlanPulseView: View {
    @AppStorage("sample.focus") private var focus: Focus = .study
    @AppStorage("sample.goal") private var goal = ""
    @AppStorage("sample.minutes") private var minutes = 20
    @AppStorage("sample.days") private var days = "2,4,6"
    @AppStorage("sample.completed") private var completed = ""
    @State private var showPreferences = false
    @Environment(\.calendar) private var calendar

    private var selectedDays: Set<Int> {
        Set(days.split(separator: ",").compactMap { Int($0) })
    }

    private var schedule: [Date] {
        guard let week = calendar.dateInterval(of: .weekOfYear, for: .now) else { return [] }
        return (0..<7).compactMap { offset in
            guard let date = calendar.date(byAdding: .day, value: offset, to: week.start),
                  selectedDays.contains(calendar.component(.weekday, from: date)) else { return nil }
            return date
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Sample schedule")
                        .font(.headline)
                    Text("Choose your focus, goal, available days, and time per activity.")
                        .foregroundStyle(.secondary)
                    Button("Edit sample preferences") { showPreferences = true }
                }
                Section("This week") {
                    if schedule.isEmpty {
                        Text("Choose at least one available day.")
                    }
                    ForEach(schedule, id: \.self) { date in
                        let key = "\(focus.rawValue)|\(date.timeIntervalSince1970)"
                        let done = completed.split(separator: ";").contains { String($0) == key }
                        Button {
                            var keys = completed.split(separator: ";").map(String.init)
                            if done { keys.removeAll { $0 == key } } else { keys.append(key) }
                            completed = keys.suffix(90).joined(separator: ";")
                        } label: {
                            HStack {
                                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading) {
                                    Text(date, format: .dateTime.weekday(.wide).month().day())
                                    Text("\(focus.rawValue) · \(minutes) min")
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .accessibilityValue(done ? "Complete" : "Incomplete")
                    }
                }
                if !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Section("Your goal") { Text(goal) }
                }
            }
            .navigationTitle("PlanPulse")
            .sheet(isPresented: $showPreferences) {
                NavigationStack {
                    Form {
                        Picker("Focus", selection: $focus) {
                            ForEach(Focus.allCases) { option in Text(option.rawValue).tag(option) }
                        }
                        TextField("What do you want to work toward?", text: $goal, axis: .vertical)
                        Stepper("\(minutes) minutes per activity", value: $minutes, in: 5...120, step: 5)
                        Section("Available days") {
                            ForEach(1...7, id: \.self) { day in
                                Toggle(calendar.weekdaySymbols[day - 1], isOn: Binding(
                                    get: { selectedDays.contains(day) },
                                    set: { enabled in
                                        var selection = selectedDays
                                        if enabled { selection.insert(day) } else { selection.remove(day) }
                                        days = selection.sorted().map(String.init).joined(separator: ",")
                                    }
                                ))
                            }
                        }
                    }
                    .navigationTitle("Sample preferences")
                    .toolbar { ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showPreferences = false }
                    } }
                }
            }
        }
        .tint(.purple)
    }
}
