package panel

import (
	"bytes"
	"fmt"
	"io"
	"strings"

	"gopkg.in/yaml.v3"
)

type mergeOperator uint8

const (
	mergeNormal mergeOperator = iota
	mergeForce
	mergePrepend
	mergeAppend
)

func mergeYAML(base string, overrides []OverrideItem) ([]byte, error) {
	root, err := parseYAMLDocument([]byte(base), "base configuration")
	if err != nil {
		return nil, err
	}
	for index, item := range overrides {
		if !item.Enabled {
			continue
		}
		patch, err := parseYAMLDocument([]byte(item.Content), fmt.Sprintf("override %q", item.Name))
		if err != nil {
			return nil, fmt.Errorf("override %d: %w", index+1, err)
		}
		if err := mergeMapping(root, patch); err != nil {
			return nil, fmt.Errorf("override %d (%s): %w", index+1, displayOverrideName(item), err)
		}
	}
	setMappingScalar(root, "external-controller-unix", defaultControllerSocket)

	doc := &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{root}}
	var output bytes.Buffer
	encoder := yaml.NewEncoder(&output)
	encoder.SetIndent(2)
	if err := encoder.Encode(doc); err != nil {
		return nil, fmt.Errorf("encode effective configuration: %w", err)
	}
	_ = encoder.Close()
	return output.Bytes(), nil
}

func parseYAMLDocument(data []byte, label string) (*yaml.Node, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		data = []byte("{}\n")
	}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	var doc yaml.Node
	if err := decoder.Decode(&doc); err != nil {
		return nil, fmt.Errorf("parse %s: %w", label, err)
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s must contain a YAML mapping at its root", label)
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("%s must contain exactly one YAML document", label)
		}
		return nil, fmt.Errorf("parse %s: %w", label, err)
	}
	return cloneNode(doc.Content[0]), nil
}

func mergeMapping(target, patch *yaml.Node) error {
	if target.Kind != yaml.MappingNode || patch.Kind != yaml.MappingNode {
		return fmt.Errorf("object merge requires mappings")
	}
	for i := 0; i+1 < len(patch.Content); i += 2 {
		patchKey, patchValue := patch.Content[i], patch.Content[i+1]
		key, operator := parseMergeKey(patchKey.Value)
		if key == "" {
			return fmt.Errorf("override key %q resolves to an empty key", patchKey.Value)
		}
		index := mappingIndex(target, key)

		switch operator {
		case mergePrepend, mergeAppend:
			if patchValue.Kind != yaml.SequenceNode {
				return fmt.Errorf("%q uses an array operator but its value is not an array", patchKey.Value)
			}
			var combined []*yaml.Node
			if index >= 0 {
				current := target.Content[index+1]
				if current.Kind != yaml.SequenceNode {
					return fmt.Errorf("%q uses an array operator but the existing value is not an array", patchKey.Value)
				}
				if operator == mergePrepend {
					combined = append(cloneNodes(patchValue.Content), cloneNodes(current.Content)...)
				} else {
					combined = append(cloneNodes(current.Content), cloneNodes(patchValue.Content)...)
				}
			} else {
				combined = cloneNodes(patchValue.Content)
			}
			value := cloneNode(patchValue)
			value.Content = combined
			setMappingNode(target, index, key, patchKey, value)

		case mergeForce:
			setMappingNode(target, index, key, patchKey, cloneNode(patchValue))

		default:
			if index >= 0 && target.Content[index+1].Kind == yaml.MappingNode && patchValue.Kind == yaml.MappingNode {
				if err := mergeMapping(target.Content[index+1], patchValue); err != nil {
					return fmt.Errorf("at %q: %w", key, err)
				}
				continue
			}
			setMappingNode(target, index, key, patchKey, cloneNode(patchValue))
		}
	}
	return nil
}

func parseMergeKey(raw string) (string, mergeOperator) {
	// Angle brackets escape operator-looking characters in a literal key.
	if strings.HasPrefix(raw, "<") && strings.HasSuffix(raw, ">") && len(raw) >= 2 {
		return raw[1 : len(raw)-1], mergeNormal
	}
	if strings.HasPrefix(raw, "+<") && strings.HasSuffix(raw, ">") && len(raw) >= 3 {
		return raw[2 : len(raw)-1], mergePrepend
	}
	if strings.HasPrefix(raw, "<") && strings.HasSuffix(raw, ">+") && len(raw) >= 3 {
		return raw[1 : len(raw)-2], mergeAppend
	}
	if strings.HasSuffix(raw, "!") {
		return strings.TrimSuffix(raw, "!"), mergeForce
	}
	if strings.HasPrefix(raw, "+") {
		return strings.TrimPrefix(raw, "+"), mergePrepend
	}
	if strings.HasSuffix(raw, "+") {
		return strings.TrimSuffix(raw, "+"), mergeAppend
	}
	return raw, mergeNormal
}

func mappingIndex(node *yaml.Node, key string) int {
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			return i
		}
	}
	return -1
}

func setMappingNode(mapping *yaml.Node, index int, key string, sourceKey, value *yaml.Node) {
	keyNode := cloneNode(sourceKey)
	keyNode.Value = key
	keyNode.Tag = "!!str"
	if index >= 0 {
		mapping.Content[index] = keyNode
		mapping.Content[index+1] = value
		return
	}
	mapping.Content = append(mapping.Content, keyNode, value)
}

func setMappingScalar(mapping *yaml.Node, key, value string) {
	index := mappingIndex(mapping, key)
	keyNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	valueNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
	setMappingNode(mapping, index, key, keyNode, valueNode)
}

func cloneNodes(nodes []*yaml.Node) []*yaml.Node {
	return cloneNodesMemo(nodes, make(map[*yaml.Node]*yaml.Node))
}

func cloneNodesMemo(nodes []*yaml.Node, memo map[*yaml.Node]*yaml.Node) []*yaml.Node {
	result := make([]*yaml.Node, len(nodes))
	for i, node := range nodes {
		result[i] = cloneNodeMemo(node, memo)
	}
	return result
}

func cloneNode(node *yaml.Node) *yaml.Node {
	return cloneNodeMemo(node, make(map[*yaml.Node]*yaml.Node))
}

func cloneNodeMemo(node *yaml.Node, memo map[*yaml.Node]*yaml.Node) *yaml.Node {
	if node == nil {
		return nil
	}
	if existing := memo[node]; existing != nil {
		return existing
	}
	copy := *node
	memo[node] = &copy
	copy.Content = cloneNodesMemo(node.Content, memo)
	copy.Alias = nil
	if node.Alias != nil {
		copy.Alias = cloneNodeMemo(node.Alias, memo)
	}
	return &copy
}

func displayOverrideName(item OverrideItem) string {
	if strings.TrimSpace(item.Name) != "" {
		return item.Name
	}
	return item.ID
}
