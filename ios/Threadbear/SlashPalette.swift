import SwiftUI
import ThreadbearKit

/// The Mac's slash command palette, as the phone has room for it: over the
/// reply box while what's typed starts with "/", the categories as chips
/// across the top, and each command with its description. A tap puts the
/// command in the box, with a space after it when it takes details, ready
/// to send. The list and its matching are the Mac's (SlashCommands.swift,
/// shared with ThreadbearCore), asked of the thread's runner through the
/// backend (phone:slashCommands, API 62).
struct SlashPaletteList: View {
    @Environment(AppModel.self) private var model
    let threadId: String
    let provider: String
    let query: String
    var onPick: (SlashCommand) -> Void
    @State private var category: SlashPalette.Category = .all

    var body: some View {
        let all = model.slashCommands[threadId]
        let recent = model.recentSlashCommands
        VStack(alignment: .leading, spacing: 8) {
            if let all {
                chips(all, recent: recent)
                let matches = SlashPalette.matches(all, query: query, category: category, recent: recent)
                if matches.isEmpty {
                    note("No command matches /\(query). Send it and it goes to the agent as words.")
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(matches) { command in
                                row(command)
                                if command != matches.last { Divider() }
                            }
                        }
                    }
                    .frame(maxHeight: 260)
                    .fixedSize(horizontal: false, vertical: true)
                }
            } else if let problem = model.slashCommandsProblem[threadId] {
                note(problem)
            } else {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Getting this thread's commands").foregroundStyle(.secondary)
                }
                .font(.footnote)
                .padding(.vertical, 6)
            }
        }
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .task(id: threadId) { model.loadSlashCommands(threadId) }
    }

    private func chips(_ all: [SlashCommand], recent: [String]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(SlashPalette.counts(all, query: query, recent: recent), id: \.0) { item, count in
                    Button {
                        category = item
                    } label: {
                        Text("\(item.title(provider: provider)) \(count)")
                            .font(.footnote)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(category == item ? Color.accentColor.opacity(0.25) : Color(.tertiarySystemBackground), in: Capsule())
                    }
                    .tint(.primary)
                    .accessibilityAddTraits(category == item ? .isSelected : [])
                }
            }
        }
        .scrollClipDisabled()
    }

    private func row(_ command: SlashCommand) -> some View {
        Button {
            model.recentSlashCommands = SlashPalette.used(command.name, recent: model.recentSlashCommands)
            onPick(command)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                // The name to tap for, its details' hint quieter after it.
                let hint = String(command.usage.dropFirst(command.name.count + 1))
                Text("\(Text("/\(command.name)").fontWeight(.semibold))\(Text(hint).foregroundStyle(.secondary))")
                    .font(.subheadline)
                    .lineLimit(1)
                if let text = command.description, !text.isEmpty {
                    Text(SlashPalette.description(text))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Puts /\(command.name) in the reply box")
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.vertical, 6)
    }
}
